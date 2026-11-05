import sql from 'mssql';
import { config } from './config.js';
import { currentTarget } from './target.js';

/** main = the selected database; msdb = SQL Agent job history; master = database discovery. */
export type PoolName = 'main' | 'msdb' | 'master';

/** One connection pool per server + database, created on first use. */
const pools = new Map<string, Promise<sql.ConnectionPool>>();

/** ODBC connection-string value, braced so characters like ; or } can't break out of it. */
function odbcValue(v: string): string {
  return `{${v.replace(/}/g, '}}')}}`;
}

/**
 * Windows Authentication: connects as the Windows account running the Node process
 * (Trusted_Connection) through the msnodesqlv8 ODBC driver. Loaded lazily so the native
 * module is only needed when DB_AUTH=windows.
 */
async function windowsPool(server: string, database: string): Promise<sql.ConnectionPool> {
  const native = (await import('mssql/msnodesqlv8.js')).default;
  const connectionString = [
    `Driver=${odbcValue(config.db.odbcDriver)}`,
    `Server=${odbcValue(server)}`,
    `Database=${odbcValue(database)}`,
    'Trusted_Connection=yes',
    `Encrypt=${config.db.encrypt ? 'yes' : 'no'}`,
    `TrustServerCertificate=${config.db.trustServerCertificate ? 'yes' : 'no'}`,
    'ApplicationIntent=ReadOnly',
    `APP=${odbcValue('NAY-Monitor (read-only)')}`,
  ].join(';');
  const pool = new native.ConnectionPool({
    connectionString,
    requestTimeout: config.db.requestTimeoutMs,
    connectionTimeout: 30_000,
    pool: { max: 10, min: 0, idleTimeoutMillis: 60_000 },
    // SQL `datetime` values are stored in server-local time; don't shift them to UTC.
    options: { useUTC: false },
  } as unknown as sql.config);
  return pool as unknown as sql.ConnectionPool;
}

function sqlLoginPool(server: string, database: string, msdb: boolean): sql.ConnectionPool {
  return new sql.ConnectionPool({
    server,
    database,
    user: msdb ? config.msdb.user : config.db.user,
    password: msdb ? config.msdb.password : config.db.password,
    requestTimeout: config.db.requestTimeoutMs,
    connectionTimeout: 30_000,
    pool: { max: 10, min: 0, idleTimeoutMillis: 60_000 },
    options: {
      encrypt: config.db.encrypt,
      trustServerCertificate: config.db.trustServerCertificate,
      // SQL `datetime` values are stored in server-local time; don't shift them to UTC.
      useUTC: false,
      readOnlyIntent: true,
      appName: 'NAY-Monitor (read-only)',
    },
  });
}

/** Pool for the current request's database (see target.ts), or for msdb/master on the same server. */
export function getPool(name: PoolName = 'main', server = currentTarget().server): Promise<sql.ConnectionPool> {
  const database = name === 'main' ? currentTarget().database : name;
  const key = `${server}|${database}`.toLowerCase();
  let poolPromise = pools.get(key);
  if (!poolPromise) {
    const create =
      config.db.auth === 'windows' ? windowsPool(server, database) : Promise.resolve(sqlLoginPool(server, database, name === 'msdb'));
    poolPromise = create
      .then((pool) => {
        pool.on('error', (err) => console.error(`[db] ${key} pool error`, err));
        return pool.connect();
      })
      .catch((err) => {
        pools.delete(key);
        throw err;
      });
    pools.set(key, poolPromise);
  }
  return poolPromise;
}

/** Site + Season the row-level security predicates filter on (SESSION_CONTEXT 'SiteID' / 'Season'). */
export interface DataContext {
  siteId: number;
  season: number;
}

/**
 * Words that must never appear in SQL issued by this service. Every statement is built
 * from fixed templates in this codebase, so this is a last line of defence that keeps the
 * backend strictly read-only even though the DB login itself has write rights.
 */
const FORBIDDEN =
  /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE|GRANT|REVOKE|DENY|BACKUP|RESTORE|DBCC|SHUTDOWN|KILL|OPENROWSET|OPENQUERY|OPENDATASOURCE|BULK|INTO)\b/i;

export function assertReadOnly(text: string): void {
  // Strip bracketed identifiers and string literals before checking keywords.
  const stripped = text.replace(/\[[^\]]*\]/g, '[]').replace(/'(?:[^']|'')*'/g, "''");
  if (!/^\s*(SELECT|WITH)\b/i.test(stripped) || stripped.includes(';') || FORBIDDEN.test(stripped)) {
    throw new Error('Refused to run a non read-only statement');
  }
}

/**
 * Fixed preamble prepended to every batch. Both keys are always (re)set — to NULL when no
 * context is given — so a pooled connection can never carry another request's Site/Season.
 */
const CONTEXT_PREAMBLE =
  "EXEC sys.sp_set_session_context @key = N'SiteID', @value = @__ctxSiteId; " +
  "EXEC sys.sp_set_session_context @key = N'Season', @value = @__ctxSeason; ";

export interface QueryOptions {
  params?: Record<string, { type: sql.ISqlTypeFactory | sql.ISqlType; value: unknown }>;
  /** Abort signal; the SQL request is cancelled on the server when it fires. */
  signal?: AbortSignal;
  /** Use READ UNCOMMITTED for this statement (avoid blocking writers on long scans). */
  dirty?: boolean;
  /** Site/Season for row-level security. */
  context?: DataContext;
  /** Which connection pool to use (default: the selected database). */
  pool?: PoolName;
  /** Server for msdb/master pools (default: the selected database's server). */
  server?: string;
}

export async function readQuery<T = Record<string, unknown>>(text: string, opts: QueryOptions = {}): Promise<T[]> {
  assertReadOnly(text);
  const pool = await getPool(opts.pool, opts.server);
  const request = pool.request();
  for (const [name, p] of Object.entries(opts.params ?? {})) {
    request.input(name, p.type as sql.ISqlType, p.value);
  }
  request.input('__ctxSiteId', sql.Int, opts.context?.siteId ?? null);
  request.input('__ctxSeason', sql.Int, opts.context?.season ?? null);
  const isolation = opts.dirty && config.readUncommitted ? 'SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; ' : '';

  if (opts.signal?.aborted) throw new CancelledError();
  const onAbort = () => request.cancel();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const result = await request.query<T>(CONTEXT_PREAMBLE + isolation + text);
    return result.recordset ?? [];
  } catch (err) {
    if (opts.signal?.aborted) throw new CancelledError();
    throw err;
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Query cancelled');
  }
}

/** Equivalent of T-SQL QUOTENAME for identifiers that come from the catalog. */
export function q(identifier: string): string {
  return `[${identifier.replace(/]/g, ']]')}]`;
}

export { sql };
