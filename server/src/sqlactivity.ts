/**
 * SQL activity: what is running now, blocking and locks, deadlocks and
 * procedure execution stats. Everything here reads SQL Server's own DMVs / Extended Events — nothing is
 * created or changed on the server. Needs VIEW SERVER STATE (granted to the monitoring login).
 *
 *  - Running now / blocking / open transactions / locks: sys.dm_exec_requests, sys.dm_exec_sessions,
 *    sys.dm_tran_* (live, a snapshot at the moment of the call).
 *  - Deadlocks: the built-in "system_health" Extended Events files (xml_deadlock_report).
 *  - Procedure stats: sys.dm_exec_procedure_stats (since each plan was cached).
 */
import { readQuery, sql } from './db.js';
import { currentTarget } from './target.js';
import { serializeRow } from './serialize.js';

type Row = Record<string, unknown>;

export type Scope = 'db' | 'server';

/** Waits that mean "idle, waiting for work" rather than "stuck" (XE readers, Service Broker, WAITFOR). */
const BACKGROUND_WAITS = [
  'XE_LIVE_TARGET_TVF',
  'BROKER_RECEIVE_WAITFOR',
  'WAITFOR',
  'SP_SERVER_DIAGNOSTICS_SLEEP',
  'XE_TIMER_EVENT',
  'BROKER_TASK_STOP',
  'HADR_WORK_QUEUE',
  'TRACEWRITE',
];

/** The statement currently executing inside a batch/procedure (from statement offsets). */
const stmt = (text: string, start: string, end: string) =>
  `LEFT(SUBSTRING(${text}, ${start} / 2 + 1, (CASE WHEN ${end} IN (-1, 0) THEN DATALENGTH(${text}) ELSE ${end} END - ${start}) / 2 + 1), 4000)`;

/* ---------------- Agent job names ---------------- */

const jobCache = new Map<string, { at: number; map: Map<string, string> }>();

/** "SQLAgent - TSQL JobStep (Job 0x… : Step 1)" → job name lookup, per server (msdb, cached 5 min). */
async function jobNames(): Promise<Map<string, string>> {
  const server = currentTarget().server;
  const c = jobCache.get(server);
  if (c && Date.now() - c.at < 5 * 60_000) return c.map;
  const map = new Map<string, string>();
  try {
    const rows = await readQuery<{ hex: string; name: string }>(
      `SELECT CONVERT(varchar(34), CONVERT(binary(16), job_id), 1) AS hex, name FROM msdb.dbo.sysjobs`,
      { pool: 'msdb' },
    );
    for (const r of rows) map.set(r.hex.toUpperCase(), r.name);
  } catch {
    /* no msdb access — show the raw program name */
  }
  jobCache.set(server, { at: Date.now(), map });
  return map;
}

function withJob(row: Row, jobs: Map<string, string>, field = 'programName'): Row {
  const app = typeof row[field] === 'string' ? (row[field] as string) : '';
  const m = /Job (0x[0-9A-F]{32}) : Step (\d+)/i.exec(app);
  if (m) {
    const name = jobs.get(m[1].toUpperCase());
    row.jobName = name ? `${name} · step ${m[2]}` : null;
  } else {
    row.jobName = null;
  }
  return row;
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/* ---------------- Live: running, blocking, open transactions ---------------- */

export async function liveActivity(scope: Scope, showBackground: boolean, signal?: AbortSignal) {
  const all = scope === 'server' ? 1 : 0;
  const params = { all: { type: sql.Bit, value: all } };
  const bg = showBackground ? '' : `AND ISNULL(r.wait_type, '') NOT IN (${BACKGROUND_WAITS.map((w) => `'${w}'`).join(', ')})`;

  const [running, blockers, transactions, jobs, server] = await Promise.all([
    readQuery<Row>(
      `SELECT r.session_id AS sessionId, DB_NAME(CASE WHEN st.objectid IS NOT NULL THEN st.dbid ELSE r.database_id END) AS db, r.status, r.command,
         CASE WHEN st.objectid IS NOT NULL THEN OBJECT_SCHEMA_NAME(st.objectid, st.dbid) + '.' + OBJECT_NAME(st.objectid, st.dbid) END AS procName,
         ${stmt('st.text', 'r.statement_start_offset', 'r.statement_end_offset')} AS statement,
         LEFT(st.text, 4000) AS batchText,
         r.start_time AS startTime, r.total_elapsed_time AS elapsedMs, r.cpu_time AS cpuMs,
         r.logical_reads AS logicalReads, r.reads, r.writes, r.row_count AS rowsAffected,
         r.wait_type AS waitType, r.wait_time AS waitMs, r.wait_resource AS waitResource, r.last_wait_type AS lastWaitType,
         NULLIF(r.blocking_session_id, 0) AS blockedBy, r.open_transaction_count AS openTransactions,
         r.percent_complete AS percentComplete,
         CASE r.transaction_isolation_level WHEN 1 THEN 'Read uncommitted' WHEN 2 THEN 'Read committed' WHEN 3 THEN 'Repeatable read'
           WHEN 4 THEN 'Serializable' WHEN 5 THEN 'Snapshot' ELSE 'Unspecified' END AS isolation,
         s.login_name AS loginName, s.host_name AS hostName, s.program_name AS programName
       FROM sys.dm_exec_requests r
       JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id
       OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) st
       WHERE r.session_id <> @@SPID AND s.is_user_process = 1 AND (@all = 1 OR r.database_id = DB_ID() OR (st.objectid IS NOT NULL AND st.dbid = DB_ID())) ${bg}
       ORDER BY r.total_elapsed_time DESC`,
      { params, signal },
    ),
    // Every session that blocks someone (even when it is idle with an open transaction), with its last SQL.
    readQuery<Row>(
      `SELECT s.session_id AS sessionId, s.status, DB_NAME(s.database_id) AS db, s.login_name AS loginName, s.host_name AS hostName,
         s.program_name AS programName, s.open_transaction_count AS openTransactions,
         s.last_request_start_time AS lastRequestStart, s.last_request_end_time AS lastRequestEnd,
         (SELECT COUNT(*) FROM sys.dm_exec_requests w WHERE w.blocking_session_id = s.session_id) AS blocking,
         (SELECT NULLIF(MAX(rr.blocking_session_id), 0) FROM sys.dm_exec_requests rr WHERE rr.session_id = s.session_id) AS blockedBy,
         (SELECT TOP 1 LEFT(t.text, 4000) FROM sys.dm_exec_connections c CROSS APPLY sys.dm_exec_sql_text(c.most_recent_sql_handle) t
            WHERE c.session_id = s.session_id) AS lastSql
       FROM sys.dm_exec_sessions s
       WHERE s.session_id IN (SELECT r.blocking_session_id FROM sys.dm_exec_requests r WHERE r.blocking_session_id > 0 AND r.blocking_session_id <> r.session_id)`,
      { signal },
    ),
    readQuery<Row>(
      `SELECT TOP (100) tst.session_id AS sessionId, s.status, DB_NAME(dt.database_id) AS db, at.name AS transactionName,
         at.transaction_begin_time AS beganAt, DATEDIFF(second, at.transaction_begin_time, GETDATE()) AS openSeconds,
         dt.database_transaction_log_bytes_used AS logBytes,
         (SELECT COUNT(*) FROM sys.dm_tran_locks l WHERE l.request_session_id = tst.session_id) AS locks,
         s.login_name AS loginName, s.host_name AS hostName, s.program_name AS programName,
         s.last_request_end_time AS lastRequestEnd,
         (SELECT TOP 1 LEFT(t.text, 4000) FROM sys.dm_exec_connections c CROSS APPLY sys.dm_exec_sql_text(c.most_recent_sql_handle) t
            WHERE c.session_id = tst.session_id) AS lastSql
       FROM sys.dm_tran_session_transactions tst
       JOIN sys.dm_tran_active_transactions at ON at.transaction_id = tst.transaction_id
       JOIN sys.dm_tran_database_transactions dt ON dt.transaction_id = tst.transaction_id
       JOIN sys.dm_exec_sessions s ON s.session_id = tst.session_id
       WHERE tst.session_id <> @@SPID AND s.is_user_process = 1 AND dt.database_id > 4
         AND (@all = 1 OR dt.database_id = DB_ID())
       ORDER BY at.transaction_begin_time`,
      { params, signal },
    ),
    jobNames(),
    readQuery<{ server: string; version: string; startedAt: Date }>(
      `SELECT @@SERVERNAME AS server, CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(40)) AS version,
         (SELECT sqlserver_start_time FROM sys.dm_os_sys_info) AS startedAt`,
      { signal },
    ),
  ]);

  const runningRows = running.map((r) => withJob(serializeRow(r), jobs));
  for (const r of runningRows) for (const k of ['elapsedMs', 'cpuMs', 'logicalReads', 'reads', 'writes', 'rowsAffected', 'waitMs']) r[k] = num(r[k]);
  const blockerRows = blockers.map((r) => withJob(serializeRow(r), jobs));
  const txRows = transactions.map((r) => withJob(serializeRow(r), jobs));
  for (const r of txRows) for (const k of ['openSeconds', 'logBytes', 'locks']) r[k] = num(r[k]);

  return {
    scope,
    server: serializeRow(server[0] as unknown as Row),
    at: serializeRow({ at: new Date() }).at,
    running: runningRows,
    blockers: blockerRows,
    transactions: txRows,
  };
}

/* ---------------- Locks held / waited for ---------------- */

export async function lockSummary(scope: Scope, signal?: AbortSignal) {
  const rows = await readQuery<Row>(
    `SELECT TOP (500) x.sessionId, x.db, x.resourceType, x.mode, x.status, COUNT_BIG(*) AS locks,
       CASE WHEN x.dbId = DB_ID() AND x.objectId IS NOT NULL THEN OBJECT_SCHEMA_NAME(x.objectId) + '.' + OBJECT_NAME(x.objectId)
            WHEN x.resourceType = 'OBJECT' THEN OBJECT_SCHEMA_NAME(x.objectId, x.dbId) + '.' + OBJECT_NAME(x.objectId, x.dbId) END AS objectName,
       s.login_name AS loginName, s.program_name AS programName, s.status AS sessionStatus
     FROM (
       SELECT l.request_session_id AS sessionId, l.resource_database_id AS dbId, DB_NAME(l.resource_database_id) AS db,
         l.resource_type AS resourceType, l.request_mode AS mode, l.request_status AS status,
         CASE WHEN l.resource_type = 'OBJECT' THEN CAST(l.resource_associated_entity_id AS int) ELSE p.object_id END AS objectId
       FROM sys.dm_tran_locks l
       LEFT JOIN sys.partitions p ON l.resource_type IN ('PAGE', 'KEY', 'RID', 'HOBT')
         AND l.resource_database_id = DB_ID() AND p.hobt_id = l.resource_associated_entity_id
       WHERE l.resource_type <> 'DATABASE' AND l.request_session_id <> @@SPID AND l.request_session_id > 0
         AND (@all = 1 OR l.resource_database_id = DB_ID())
     ) x
     JOIN sys.dm_exec_sessions s ON s.session_id = x.sessionId
     GROUP BY x.sessionId, x.dbId, x.db, x.resourceType, x.mode, x.status, x.objectId, s.login_name, s.program_name, s.status
     ORDER BY CASE WHEN x.status = 'WAIT' THEN 0 ELSE 1 END, COUNT_BIG(*) DESC`,
    { params: { all: { type: sql.Bit, value: scope === 'server' ? 1 : 0 } }, signal },
  );
  const jobs = await jobNames();
  return rows.map((r) => {
    const o = withJob(serializeRow(r), jobs);
    o.locks = num(o.locks);
    return o;
  });
}

/* ---------------- Deadlocks (system_health XE files) ---------------- */

const deadlockCache = new Map<string, { at: number; rows: Row[] }>();

export async function deadlocks(scope: Scope, refresh: boolean, signal?: AbortSignal) {
  const server = currentTarget().server;
  let c = deadlockCache.get(server);
  if (!c || refresh || Date.now() - c.at > 60_000) {
    const rows = await readQuery<Row>(
      `WITH f AS (
         SELECT CAST(event_data AS xml) AS x
         FROM sys.fn_xe_file_target_read_file(N'system_health*.xel', NULL, NULL, NULL)
         WHERE object_name = N'xml_deadlock_report'
       ), d AS (
         SELECT
           CONVERT(datetime2(3), SWITCHOFFSET(f.x.value('(event/@timestamp)[1]', 'datetimeoffset'), DATEPART(TZOFFSET, SYSDATETIMEOFFSET()))) AS at,
           f.x.value('(event/@timestamp)[1]', 'nvarchar(40)') AS id,
           f.x.query('(event/data/value/deadlock)[1]') AS g
         FROM f
       )
       SELECT d.at, d.id,
         p.n.value('@id', 'nvarchar(60)') AS processId,
         CASE WHEN d.g.exist('deadlock/victim-list/victimProcess[@id = sql:column("k.processKey")]') = 1 THEN 1 ELSE 0 END AS isVictim,
         p.n.value('@spid', 'int') AS sessionId,
         COALESCE(p.n.value('@currentdbname', 'nvarchar(256)'), DB_NAME(p.n.value('@currentdb', 'int'))) AS db,
         p.n.value('@loginname', 'nvarchar(256)') AS loginName,
         p.n.value('@hostname', 'nvarchar(256)') AS hostName,
         p.n.value('@clientapp', 'nvarchar(256)') AS programName,
         p.n.value('@lockMode', 'nvarchar(40)') AS lockMode,
         p.n.value('@waitresource', 'nvarchar(256)') AS waitResource,
         p.n.value('@waittime', 'bigint') AS waitMs,
         p.n.value('@isolationlevel', 'nvarchar(60)') AS isolation,
         p.n.value('(executionStack/frame/@procname)[1]', 'nvarchar(400)') AS procName,
         p.n.value('(executionStack/frame/@line)[1]', 'int') AS lineNumber,
         LEFT(LTRIM(RTRIM(p.n.value('(inputbuf)[1]', 'nvarchar(max)'))), 4000) AS inputBuffer,
         STUFF((SELECT DISTINCT ', ' + r.o.value('@objectname', 'nvarchar(400)')
                FROM d.g.nodes('deadlock/resource-list/*') r(o) WHERE r.o.value('@objectname', 'nvarchar(400)') IS NOT NULL
                FOR XML PATH('')), 1, 2, '') AS objects
       FROM d
       CROSS APPLY d.g.nodes('deadlock/process-list/process') p(n)
       CROSS APPLY (SELECT p.n.value('@id', 'nvarchar(60)') AS processKey) k
       ORDER BY d.at DESC`,
      { signal },
    );
    const jobs = await jobNames();
    // One entry per deadlock, with its processes.
    const map = new Map<string, Row & { processes: Row[] }>();
    for (const raw of rows) {
      const r = withJob(serializeRow(raw), jobs);
      let d = map.get(String(r.id));
      if (!d) {
        d = { id: r.id, at: r.at, objects: r.objects, dbs: [] as string[], processes: [] };
        map.set(String(r.id), d);
      }
      const dbs = d.dbs as string[];
      if (r.db && !dbs.includes(String(r.db))) dbs.push(String(r.db));
      d.processes.push({
        sessionId: r.sessionId,
        isVictim: r.isVictim === 1,
        db: r.db,
        loginName: r.loginName,
        hostName: r.hostName,
        programName: r.programName,
        jobName: r.jobName,
        lockMode: r.lockMode,
        waitResource: r.waitResource,
        waitMs: num(r.waitMs),
        isolation: r.isolation,
        procName: r.procName,
        lineNumber: r.lineNumber,
        inputBuffer: r.inputBuffer,
      });
    }
    c = { at: Date.now(), rows: [...map.values()] };
    deadlockCache.set(server, c);
  }
  const db = currentTarget().database.toLowerCase();
  const rows = scope === 'server' ? c.rows : c.rows.filter((d) => (d.dbs as string[]).some((x) => x.toLowerCase() === db));
  return { scope, rows, oldest: c.rows.length ? c.rows[c.rows.length - 1].at : null, readAt: serializeRow({ at: new Date(c.at) }).at };
}

/* ---------------- Procedure execution stats ---------------- */

const PROC_SORTS: Record<string, string> = {
  total: 'ps.total_elapsed_time',
  avg: 'ps.total_elapsed_time / ps.execution_count',
  max: 'ps.max_elapsed_time',
  count: 'ps.execution_count',
  last: 'ps.last_execution_time',
  cpu: 'ps.total_worker_time',
  reads: 'ps.total_logical_reads',
};

export const procSortKeys = Object.keys(PROC_SORTS);

export async function procedureStats(scope: Scope, sort: string, signal?: AbortSignal) {
  const order = PROC_SORTS[sort] ?? PROC_SORTS.total;
  const rows = await readQuery<Row>(
    `SELECT TOP (300) DB_NAME(ps.database_id) AS db,
       OBJECT_SCHEMA_NAME(ps.object_id, ps.database_id) + '.' + OBJECT_NAME(ps.object_id, ps.database_id) AS procName,
       ps.type_desc AS type, ps.cached_time AS cachedAt, ps.last_execution_time AS lastRun,
       ps.execution_count AS executions,
       ps.total_elapsed_time / 1000 AS totalMs,
       ps.total_elapsed_time / ps.execution_count / 1000.0 AS avgMs,
       ps.max_elapsed_time / 1000.0 AS maxMs,
       ps.last_elapsed_time / 1000.0 AS lastMs,
       ps.total_worker_time / ps.execution_count / 1000.0 AS avgCpuMs,
       ps.total_logical_reads / ps.execution_count AS avgReads,
       ps.total_logical_writes / ps.execution_count AS avgWrites
     FROM sys.dm_exec_procedure_stats ps
     WHERE ps.execution_count > 0 AND ps.database_id <> 32767 AND (@all = 1 OR ps.database_id = DB_ID())
     ORDER BY ${order} DESC`,
    { params: { all: { type: sql.Bit, value: scope === 'server' ? 1 : 0 } }, signal },
  );
  return rows.map((r) => {
    const o = serializeRow(r);
    for (const k of ['executions', 'totalMs', 'avgMs', 'maxMs', 'lastMs', 'avgCpuMs', 'avgReads', 'avgWrites']) o[k] = num(o[k]);
    return o;
  });
}
