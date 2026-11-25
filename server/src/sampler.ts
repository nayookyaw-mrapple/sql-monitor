/**
 * Activity sampler: every few seconds, look at each server in HISTORY_SERVERS and save to the local SQLite history
 *  - what is executing right now (the same view as "Running now"), and
 *  - the last batch each connected session finished since the previous poll, which catches quick queries.
 * Runs all the time, viewer or not. Read-only: two SELECTs on system views per poll.
 *
 * This is a SAMPLE, not an audit: only the newest finished batch per session is visible, and a session that
 * connects, runs and disconnects between two polls is never seen.
 * The complete record comes from SQL Server Audit (audit.ts).
 */
import { createHash } from 'node:crypto';
import { config } from './config.js';
import { readQuery, sql } from './db.js';
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
const OWN_APP = 'SQL Monitor (read-only)';

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

interface RawLast {
  now: Date;
  sessionId: number;
  lastStart: Date | null;
  lastEnd: Date | null;
  db: string | null;
  procName: string | null;
  batch: string | null;
  loginName: string | null;
  hostName: string | null;
  programName: string | null;
  clientAddress: string | null;
}

/**
 * The last thing each connected session ran and has already finished. SQL Server keeps this per session, so a
 * query far too quick to be "seen running" is still caught, as long as the session stays connected until the next
 * poll (SSMS and pooled application connections do). Only the newest batch per session is available.
 * A session with a request in flight is left to the running sample.
 */
const LAST_SQL = `SELECT SYSDATETIME() AS now, s.session_id AS sessionId, s.last_request_start_time AS lastStart, s.last_request_end_time AS lastEnd,
    DB_NAME(CASE WHEN t.objectid IS NOT NULL THEN t.dbid ELSE s.database_id END) AS db,
    CASE WHEN t.objectid IS NOT NULL THEN OBJECT_SCHEMA_NAME(t.objectid, t.dbid) + '.' + OBJECT_NAME(t.objectid, t.dbid) END AS procName,
    CASE WHEN t.objectid IS NULL THEN LEFT(t.text, 4000) END AS batch,
    s.login_name AS loginName, s.host_name AS hostName, s.program_name AS programName, c.client_net_address AS clientAddress
  FROM sys.dm_exec_sessions s
  JOIN sys.dm_exec_connections c ON c.session_id = s.session_id AND c.parent_connection_id IS NULL
  OUTER APPLY sys.dm_exec_sql_text(c.most_recent_sql_handle) t
  WHERE s.session_id <> @@SPID AND s.is_user_process = 1 AND ISNULL(s.program_name, '') <> '${OWN_APP}'
    AND s.last_request_end_time >= s.last_request_start_time
    AND NOT EXISTS (SELECT 1 FROM sys.dm_exec_requests rq WHERE rq.session_id = s.session_id)
    AND s.last_request_end_time >= DATEADD(millisecond, -@windowMs, SYSDATETIME())`;

/**
 * Action of a whole batch, from its text. A change wins over a read ("SELECT …; UPDATE …" is an UPDATE), because
 * who changed something is what the history is for. Text inside strings and comments is ignored.
 */
export function actionOfText(sqlText: string | null): string {
  if (!sqlText) return 'OTHER';
  const text = sqlText
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\r\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .toUpperCase();
  const write = /\b(INSERT|UPDATE(?!\s+STATISTICS)|DELETE|MERGE|TRUNCATE)\b/.exec(text);
  if (write) return write[1];
  if (/\bEXEC(UTE)?\b/.test(text)) return 'EXECUTE';
  if (/\b(CREATE|ALTER|DROP)\s+(TABLE|PROC|PROCEDURE|VIEW|FUNCTION|INDEX|TRIGGER|SCHEMA|DATABASE|TYPE|USER|LOGIN|ROLE)\b/.test(text)) return 'DDL';
  if (/\bSELECT\b/.test(text)) return 'SELECT';
  return 'OTHER';
}

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
  /** When the previous poll was made (this machine's clock), to size the "finished since" window. */
  lastPollMs: number;
  /** Per session: start time of the newest request already saved, so it isn't saved twice. */
  savedStart: Map<number, string>;
}

const states = new Map<string, SamplerState>();

async function sampleOnce(server: string): Promise<void> {
  const st = states.get(server)!;
  // Look back to the previous poll plus a margin; anything already saved is skipped below.
  const windowMs = Math.min(10 * 60_000, (st.lastPollMs ? Date.now() - st.lastPollMs : config.history.sampleMs) + 3000);
  const pollStarted = Date.now();
  const [rows, last, jobs] = await Promise.all([
    readQuery<Raw>(SAMPLE_SQL, { pool: 'master', server }),
    readQuery<RawLast>(LAST_SQL, { pool: 'master', server, params: { windowMs: { type: sql.Int, value: Math.round(windowMs) } } }),
    jobNames(server),
  ]);
  st.lastPollMs = pollStarted;
  st.polls++;
  st.lastError = null;
  st.lastPollAt = formatDate(rows[0]?.now ?? last[0]?.now ?? new Date());

  // Finished requests: one row each, timed at the moment the request ended.
  const finished: SampleRow[] = [];
  const running = new Map(rows.map((r) => [r.sessionId, r.startTime ? formatDate(r.startTime) : null]));
  for (const r of last) {
    if (!r.lastStart || !r.lastEnd || (!r.batch && !r.procName)) continue;
    const requestStart = formatDate(r.lastStart);
    // Already saved, or the session has moved on to a new request that the running sample covers.
    if (st.savedStart.get(r.sessionId) === requestStart || running.has(r.sessionId)) continue;
    st.savedStart.set(r.sessionId, requestStart);
    const endedAt = formatDate(r.lastEnd);
    finished.push({
      // The same batch from the same login, host and app within one clock hour is one row with a count: an application
      // repeating a query every few seconds would otherwise add hundreds of thousands of rows a day.
      key: [server, 'L', endedAt.slice(0, 13), createHash('sha1').update([r.loginName, r.hostName, r.programName, r.db, r.procName, r.batch].join('\u0001')).digest('hex')].join('|'),
      capture: 'last',
      seenAt: endedAt,
      db: r.db,
      sessionId: r.sessionId,
      requestStart,
      // A procedure called directly (RPC): only its name is known, not the statements inside it.
      action: r.procName ? 'EXECUTE' : actionOfText(r.batch),
      command: null,
      procName: r.procName,
      statement: r.batch,
      tables: tablesIn(r.batch),
      loginName: r.loginName,
      hostName: r.hostName,
      clientAddress: r.clientAddress,
      programName: r.programName,
      jobName: withJob({ programName: r.programName }, jobs).jobName as string | null,
      elapsedMs: Math.max(0, r.lastEnd.getTime() - r.lastStart.getTime()),
      cpuMs: null,
      logicalReads: null,
      writes: null,
      rowsAffected: null,
    });
  }
  // Forget sessions that have gone, so the map doesn't grow for ever (session ids are reused).
  if (st.savedStart.size > 5000) st.savedStart.clear();
  // A request seen running is saved by the running sample; remember it so its "finished" twin is skipped.
  for (const [sessionId, start] of running) if (start) st.savedStart.set(sessionId, start);
  saveSamples(server, finished);

  if (rows.length === 0) return;
  const seenAt = formatDate(rows[0].now);
  const samples: SampleRow[] = rows.map((r) => {
    const requestStart = r.startTime ? formatDate(r.startTime) : null;
    const job = withJob({ programName: r.programName }, jobs).jobName as string | null;
    return {
      key: [server, r.sessionId, requestStart, r.procName ?? '', r.stmtStart ?? 0].join('|'),
      capture: 'running',
      seenAt,
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
  saveSamples(server, samples);
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
    states.set(server, { lastPollAt: null, lastError: null, polls: 0, lastPollMs: 0, savedStart: new Map() });
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
