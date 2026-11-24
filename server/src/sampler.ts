/**
 * Activity sampler: every few seconds, look at what is executing on each server in HISTORY_SERVERS (the same
 * view as "Running now") and save it to the local SQLite history. Runs all the time, viewer or not.
 *
 * This is a SAMPLE, not an audit: a statement that starts and finishes between two polls is never seen.
 * The complete record comes from SQL Server Audit (audit.ts).
 */
import { config } from './config.js';
import { readQuery } from './db.js';
import { saveSamples, type SampleRow } from './history-store.js';
import { formatDate } from './serialize.js';
import { BACKGROUND_WAITS, jobNames, stmt, withJob } from './sqlactivity.js';

interface Raw {
  now: Date;
  sessionId: number;
  startTime: Date | null;
  db: string | null;
  command: string | null;
  procName: string | null;
  statement: string | null;
  stmtStart: number | null;
  elapsedMs: number | string | null;
  cpuMs: number | string | null;
  logicalReads: number | string | null;
  writes: number | string | null;
  rowsAffected: number | string | null;
  loginName: string | null;
  hostName: string | null;
  programName: string | null;
  clientAddress: string | null;
}

/** The monitor's own connections (see db.ts) are left out so it doesn't log itself. */
const OWN_APP = 'NAY-Monitor (read-only)';

const SAMPLE_SQL = `SELECT SYSDATETIME() AS now, r.session_id AS sessionId, r.start_time AS startTime,
    DB_NAME(CASE WHEN st.objectid IS NOT NULL THEN st.dbid ELSE r.database_id END) AS db, r.command,
    CASE WHEN st.objectid IS NOT NULL THEN OBJECT_SCHEMA_NAME(st.objectid, st.dbid) + '.' + OBJECT_NAME(st.objectid, st.dbid) END AS procName,
    ${stmt('st.text', 'r.statement_start_offset', 'r.statement_end_offset')} AS statement,
    r.statement_start_offset AS stmtStart,
    r.total_elapsed_time AS elapsedMs, r.cpu_time AS cpuMs, r.logical_reads AS logicalReads, r.writes, r.row_count AS rowsAffected,
    s.login_name AS loginName, s.host_name AS hostName, s.program_name AS programName,
    (SELECT TOP 1 c.client_net_address FROM sys.dm_exec_connections c WHERE c.session_id = r.session_id) AS clientAddress
  FROM sys.dm_exec_requests r
  JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id
  OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) st
  WHERE r.session_id <> @@SPID AND s.is_user_process = 1 AND ISNULL(s.program_name, '') <> '${OWN_APP}'
    AND ISNULL(r.wait_type, '') NOT IN (${BACKGROUND_WAITS.map((w) => `'${w}'`).join(', ')})`;

/** INSERT / UPDATE / DELETE / MERGE / SELECT / EXECUTE / TRUNCATE / DDL / OTHER, from SQL Server's own command name. */
export function actionOf(command: string | null): string {
  const c = (command ?? '').toUpperCase();
  if (c === 'INSERT' || c === 'BULK INSERT' || c === 'SELECT INTO') return 'INSERT';
  if (c === 'UPDATE' || c === 'DELETE' || c === 'MERGE' || c === 'SELECT' || c === 'EXECUTE') return c;
  if (c === 'TRUNCATE TABLE') return 'TRUNCATE';
  if (/^(CREATE|ALTER|DROP)\b/.test(c)) return 'DDL';
  return 'OTHER';
}

const NAME = String.raw`(?:\[[^\]]+\]|[#\w]+)(?:\s*\.\s*(?:\[[^\]]+\]|\w+)){0,3}`;
const WRITE_TARGET = new RegExp(
  String.raw`\b(?:INSERT\s+(?:INTO\s+)?|UPDATE\s+|DELETE\s+(?:FROM\s+)?|MERGE\s+(?:INTO\s+)?|TRUNCATE\s+TABLE\s+|INTO\s+)(${NAME})`,
  'gi',
);
/** Second group: the alias, when one follows ("FROM ma_Heatmap_BinT hm"). */
const READ_SOURCE = new RegExp(String.raw`\b(?:FROM|JOIN|APPLY|USING)\s+(${NAME})(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?`, 'gi');
const NOT_A_TABLE = new Set([
  'TOP', 'SELECT', 'SET', 'FROM', 'INTO', 'WITH', 'VALUES', 'EXEC', 'EXECUTE', 'OUTPUT', 'DELETED', 'INSERTED', 'STATISTICS', 'OPENJSON',
  'OPENXML', 'OPENROWSET', 'OPENQUERY', 'STRING_SPLIT', 'GENERATE_SERIES', 'DISTINCT', 'ALL',
]);

/**
 * Best-effort list of the tables a statement names, write target first. It is a text match, so it also picks
 * up aliases, views and functions, and it cannot see inside dynamic SQL or nested procedures.
 */
export function tablesIn(sqlText: string | null): string | null {
  if (!sqlText) return null;
  const text = sqlText
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\r\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  // "UPDATE hm SET … FROM ma_Heatmap_BinT hm": hm is an alias, not a table.
  const aliases = new Set([...text.matchAll(READ_SOURCE)].map((m) => m[2]?.toLowerCase()).filter(Boolean));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const re of [WRITE_TARGET, READ_SOURCE]) {
    for (const m of text.matchAll(re)) {
      const name = m[1].replace(/[\[\]]/g, '').replace(/\s*\.\s*/g, '.');
      if (NOT_A_TABLE.has(name.toUpperCase()) || /^\d+$/.test(name) || seen.has(name.toLowerCase()) || aliases.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      out.push(name);
      if (out.length >= 12) break;
    }
  }
  return out.length ? out.join(', ').slice(0, 500) : null;
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

interface SamplerState {
  lastPollAt: string | null;
  lastError: string | null;
  polls: number;
}

const states = new Map<string, SamplerState>();

async function sampleOnce(server: string): Promise<void> {
  const [rows, jobs] = await Promise.all([readQuery<Raw>(SAMPLE_SQL, { pool: 'master', server }), jobNames(server)]);
  const st = states.get(server)!;
  st.polls++;
  st.lastError = null;
  st.lastPollAt = formatDate(rows[0]?.now ?? new Date());
  if (rows.length === 0) return;
  const seenAt = formatDate(rows[0].now);
  const samples: SampleRow[] = rows.map((r) => {
    const requestStart = r.startTime ? formatDate(r.startTime) : null;
    const job = withJob({ programName: r.programName }, jobs).jobName as string | null;
    return {
      key: [server, r.sessionId, requestStart, r.procName ?? '', r.stmtStart ?? 0].join('|'),
      db: r.db,
      sessionId: r.sessionId,
      requestStart,
      action: actionOf(r.command),
      command: r.command,
      procName: r.procName,
      statement: r.statement,
      tables: tablesIn(r.statement),
      loginName: r.loginName,
      hostName: r.hostName,
      clientAddress: r.clientAddress,
      programName: r.programName,
      jobName: job,
      elapsedMs: num(r.elapsedMs),
      cpuMs: num(r.cpuMs),
      logicalReads: num(r.logicalReads),
      writes: num(r.writes),
      rowsAffected: num(r.rowsAffected),
    };
  });
  saveSamples(server, seenAt, samples);
}

function loop(server: string): void {
  const st = states.get(server)!;
  sampleOnce(server)
    .catch((err) => {
      const msg = (err as Error).message;
      if (st.lastError !== msg) console.error(`[sampler] ${server}: ${msg}`);
      st.lastError = msg;
    })
    // After a failure wait longer, so an unreachable server isn't hammered.
    .finally(() => setTimeout(() => loop(server), st.lastError ? Math.max(30_000, config.history.sampleMs) : config.history.sampleMs).unref());
}

export function startSampler(): void {
  for (const server of config.history.servers) {
    states.set(server, { lastPollAt: null, lastError: null, polls: 0 });
    loop(server);
  }
  if (config.history.servers.length) {
    console.log(`[sampler] sampling ${config.history.servers.join(', ')} every ${config.history.sampleMs} ms`);
  }
}

export function samplerStatus(server: string) {
  const st = states.get(server.toUpperCase());
  return { enabled: !!st, intervalMs: config.history.sampleMs, lastPollAt: st?.lastPollAt ?? null, lastError: st?.lastError ?? null };
}
