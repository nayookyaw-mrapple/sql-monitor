/**
 * Audit reader: copies new SQL Server Audit records into the local SQLite history.
 *
 * SQL Monitor never creates or changes the audit. A DBA sets it up once per server with the script from
 * auditSetupScript() (shown on the Audit history tab); until then this just reports "not set up".
 * Reading uses sys.fn_get_audit_file, a plain SELECT.
 */
import { config } from './config.js';
import { readQuery, sql } from './db.js';
import { getAuditPosition, saveAuditEvents, setAuditPosition, type AuditRow } from './history-store.js';
import { formatDate } from './serialize.js';

type Row = Record<string, unknown>;

const BATCH = 5000;
/** Batches per poll, so catching up on a large backlog doesn't hold one long loop. */
const MAX_BATCHES = 20;

const ACTIONS: Record<string, string> = {
  IN: 'INSERT',
  UP: 'UPDATE',
  DL: 'DELETE',
  EX: 'EXECUTE',
  SL: 'SELECT',
  RF: 'REFERENCES',
};

interface AuditState {
  /** null = not looked up yet. */
  found: boolean | null;
  auditEnabled: boolean | null;
  pattern: string | null;
  lastReadAt: string | null;
  lastError: string | null;
  lastLookup: number;
}

const states = new Map<string, AuditState>();

/** Where the audit writes its files: from HISTORY_AUDIT_FILE_PATTERN, or looked up by audit name (rechecked every 5 min). */
async function locate(server: string, st: AuditState): Promise<void> {
  if (st.found !== null && Date.now() - st.lastLookup < 5 * 60_000) return;
  st.lastLookup = Date.now();
  if (config.history.auditFilePattern) {
    st.found = true;
    st.pattern = config.history.auditFilePattern;
    return;
  }
  const rows = await readQuery<{ path: string; enabled: boolean }>(
    `SELECT log_file_path AS path, is_state_enabled AS enabled FROM sys.server_file_audits WHERE name = @name`,
    { pool: 'master', server, params: { name: { type: sql.NVarChar(128), value: config.history.auditName } } },
  );
  if (rows.length === 0) {
    st.found = false;
    st.pattern = null;
    st.auditEnabled = null;
    return;
  }
  const path = rows[0].path.endsWith('\\') || rows[0].path.endsWith('/') ? rows[0].path : `${rows[0].path}\\`;
  st.found = true;
  st.auditEnabled = !!rows[0].enabled;
  st.pattern = `${path}${config.history.auditName}_*.sqlaudit`;
}

const text = (v: unknown, max = 400): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, max) : null);

function toAuditRow(r: Row): AuditRow | null {
  const actionId = String(r.action_id ?? '').trim();
  // "Audit session changed" marks the audit itself starting/stopping, not user activity.
  if (!actionId || actionId === 'AUSC') return null;
  return {
    eventUtc: String(r.eventUtc),
    eventTime: r.eventLocal instanceof Date ? formatDate(r.eventLocal) : String(r.eventLocal),
    sequence: Number(r.sequence_number ?? 0),
    actionId,
    action: ACTIONS[actionId] ?? actionId,
    succeeded: r.succeeded === true || r.succeeded === 1,
    sessionId: r.session_id === null || r.session_id === undefined ? null : Number(r.session_id),
    db: text(r.database_name),
    schemaName: text(r.schema_name),
    objectName: text(r.object_name),
    classType: text(r.class_type)?.trim() ?? null,
    loginName: text(r.server_principal_name),
    sessionLogin: text(r.session_server_principal_name),
    dbUser: text(r.database_principal_name),
    // These three only exist on newer SQL Server versions.
    hostName: text(r.host_name),
    clientIp: text(r.client_ip),
    programName: text(r.application_name),
    statement: text(r.statement, 4000),
  };
}

async function readBatch(server: string, pattern: string, fileName: string | null, offset: string | null): Promise<Row[]> {
  return readQuery<Row>(
    `SELECT TOP (@n) CONVERT(varchar(27), a.event_time, 126) AS eventUtc,
       CONVERT(datetime2(3), SWITCHOFFSET(CONVERT(datetimeoffset, a.event_time), DATEPART(TZOFFSET, SYSDATETIMEOFFSET()))) AS eventLocal,
       a.*
     FROM sys.fn_get_audit_file(@pattern, @file, @offset) a`,
    {
      pool: 'master',
      server,
      params: {
        n: { type: sql.Int, value: BATCH },
        pattern: { type: sql.NVarChar(260), value: pattern },
        file: { type: sql.NVarChar(260), value: fileName },
        offset: { type: sql.BigInt, value: offset },
      },
    },
  );
}

async function ingest(server: string): Promise<void> {
  const st = states.get(server)!;
  await locate(server, st);
  if (!st.found || !st.pattern) return;

  let pos = getAuditPosition(server);
  for (let i = 0; i < MAX_BATCHES; i++) {
    let rows: Row[];
    try {
      rows = await readBatch(server, st.pattern, pos.fileName, pos.offset);
    } catch (err) {
      // The file we stopped in was rolled over and deleted: start again from the oldest file (duplicates are ignored).
      if (pos.fileName && i === 0) {
        rows = await readBatch(server, st.pattern, null, null);
        pos = { fileName: null, offset: null };
      } else {
        throw err;
      }
    }
    if (rows.length === 0) break;
    saveAuditEvents(server, rows.map(toAuditRow).filter((r): r is AuditRow => r !== null));
    const last = rows[rows.length - 1];
    const next = { fileName: String(last.file_name), offset: String(last.audit_file_offset) };
    const stuck = next.fileName === pos.fileName && next.offset === pos.offset;
    pos = next;
    setAuditPosition(server, pos.fileName, pos.offset);
    if (rows.length < BATCH || stuck) break;
  }
  st.lastReadAt = formatDate(new Date());
  st.lastError = null;
}

function loop(server: string): void {
  const st = states.get(server)!;
  ingest(server)
    .catch((err) => {
      const msg = (err as Error).message;
      if (st.lastError !== msg) console.error(`[audit] ${server}: ${msg}`);
      st.lastError = msg;
    })
    .finally(() => setTimeout(() => loop(server), config.history.auditPollMs).unref());
}

export function startAuditReader(): void {
  for (const server of config.history.servers) {
    states.set(server, { found: null, auditEnabled: null, pattern: null, lastReadAt: null, lastError: null, lastLookup: 0 });
    loop(server);
  }
}

export function auditStatus(server: string) {
  const st = states.get(server.toUpperCase());
  return {
    enabled: !!st,
    auditName: config.history.auditName,
    found: st?.found ?? null,
    auditEnabled: st?.auditEnabled ?? null,
    filePattern: st?.pattern ?? null,
    lastReadAt: st?.lastReadAt ?? null,
    lastError: st?.lastError ?? null,
  };
}

const ident = (v: string) => `[${v.replace(/]/g, ']]')}]`;

/**
 * The one-time setup a DBA runs. SQL Monitor only displays this text; it never runs it.
 * Covers every table and procedure in the database (INSERT/UPDATE/DELETE/EXECUTE by anyone).
 */
export function auditSetupScript(database: string, login: string): string {
  const audit = ident(config.history.auditName);
  const spec = ident(`${config.history.auditName}_${database}`);
  return `-- SQL Monitor audit setup. Run once, as a sysadmin. SQL Monitor itself never runs this.
-- Records every INSERT / UPDATE / DELETE / EXECUTE on every table and procedure in ${database}.
-- ON_FAILURE = CONTINUE: if the audit cannot write, applications keep working.
-- Disk use is capped at MAXSIZE x MAX_ROLLOVER_FILES (about 10 GB below); the oldest file is then reused.

-- 1) Once per SQL Server: where the records are written. Change FILEPATH to an existing folder.
USE master;
CREATE SERVER AUDIT ${audit}
  TO FILE (FILEPATH = N'D:\\SQLAudit\\', MAXSIZE = 256 MB, MAX_ROLLOVER_FILES = 40, RESERVE_DISK_SPACE = OFF)
  WITH (QUEUE_DELAY = 1000, ON_FAILURE = CONTINUE)
  WHERE schema_name <> 'sys';   -- leaves out system procedures such as sp_executesql
ALTER SERVER AUDIT ${audit} WITH (STATE = ON);

-- 2) Once per database to audit (repeat this block for other databases).
USE ${ident(database)};
CREATE DATABASE AUDIT SPECIFICATION ${spec}
  FOR SERVER AUDIT ${audit}
  ADD (INSERT, UPDATE, DELETE, EXECUTE ON DATABASE::${ident(database)} BY [public])
  WITH (STATE = ON);

-- 3) Let SQL Monitor read the audit files (SQL Server 2022+).
--    On older versions use: GRANT CONTROL SERVER TO ${ident(login)};
USE master;
GRANT VIEW SERVER SECURITY AUDIT TO ${ident(login)};

-- To stop auditing later:
--   USE ${ident(database)}; ALTER DATABASE AUDIT SPECIFICATION ${spec} WITH (STATE = OFF); DROP DATABASE AUDIT SPECIFICATION ${spec};
--   USE master; ALTER SERVER AUDIT ${audit} WITH (STATE = OFF); DROP SERVER AUDIT ${audit};
`;
}
