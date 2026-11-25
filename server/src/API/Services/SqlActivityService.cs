using System.Collections.Concurrent;
using System.Text.RegularExpressions;
using API.Configuration;
using API.Infrastructure;

namespace API.Services
{
    /// <summary>
    /// SQL activity: what is running now, blocking and locks, deadlocks and
    /// procedure execution stats. Everything here reads SQL Server's own DMVs / Extended Events — nothing is
    /// created or changed on the server. Needs VIEW SERVER STATE (granted to the monitoring login).
    ///
    ///  - Running now / blocking / open transactions / locks: sys.dm_exec_requests, sys.dm_exec_sessions,
    ///    sys.dm_tran_* (live, a snapshot at the moment of the call).
    ///  - Deadlocks: the built-in "system_health" Extended Events files (xml_deadlock_report).
    ///  - Procedure stats: sys.dm_exec_procedure_stats (since each plan was cached).
    /// </summary>
    public sealed class SqlActivityService
    {
        /// <summary>Waits that mean "idle, waiting for work" rather than "stuck" (XE readers, Service Broker, WAITFOR).</summary>
        public static readonly string[] BackgroundWaits =
        {
            "XE_LIVE_TARGET_TVF",
            "BROKER_RECEIVE_WAITFOR",
            "WAITFOR",
            "SP_SERVER_DIAGNOSTICS_SLEEP",
            "XE_TIMER_EVENT",
            "BROKER_TASK_STOP",
            "HADR_WORK_QUEUE",
            "TRACEWRITE",
        };

        /// <summary>The background waits as a SQL list: 'A', 'B', …</summary>
        public static readonly string BackgroundWaitList = string.Join(", ", BackgroundWaits.Select(w => $"'{w}'"));

        private static readonly Regex JobStep = new(@"Job (0x[0-9A-F]{32}) : Step (\d+)", RegexOptions.IgnoreCase | RegexOptions.Compiled);

        private static readonly Dictionary<string, string> ProcSorts = new()
        {
            ["total"] = "ps.total_elapsed_time",
            ["avg"] = "ps.total_elapsed_time / ps.execution_count",
            ["max"] = "ps.max_elapsed_time",
            ["count"] = "ps.execution_count",
            ["last"] = "ps.last_execution_time",
            ["cpu"] = "ps.total_worker_time",
            ["reads"] = "ps.total_logical_reads",
        };

        /// <summary>Valid sort keys of the procedure stats.</summary>
        public static readonly IReadOnlyCollection<string> ProcSortKeys = ProcSorts.Keys;

        private readonly Db _db;
        private readonly TargetRegistry _targets;
        private readonly MonitorConfig _config;
        private readonly HistoryStore _history;
        private readonly ConcurrentDictionary<string, (long At, Dictionary<string, string> Map)> _jobCache = new();
        private readonly ConcurrentDictionary<string, DeadlockCache> _deadlockCache = new();

        /// <summary>Creates the service.</summary>
        public SqlActivityService(Db db, TargetRegistry targets, MonitorConfig config, HistoryStore history)
        {
            _db = db;
            _targets = targets;
            _config = config;
            _history = history;
        }

        /// <summary>The statement currently executing inside a batch/procedure (from statement offsets).</summary>
        public static string Stmt(string text, string start, string end) =>
            $"LEFT(SUBSTRING({text}, {start} / 2 + 1, (CASE WHEN {end} IN (-1, 0) THEN DATALENGTH({text}) ELSE {end} END - {start}) / 2 + 1), 4000)";

        /* ---------------- Agent job names ---------------- */

        /// <summary>"SQLAgent - TSQL JobStep (Job 0x… : Step 1)" → job name lookup, per server (msdb, cached 5 min).</summary>
        public async Task<Dictionary<string, string>> JobNamesAsync(string? server = null)
        {
            server ??= _targets.Current.Server;
            if (_jobCache.TryGetValue(server, out var c) && Js.NowMs() - c.At < 5 * 60_000) return c.Map;
            var map = new Dictionary<string, string>();
            try
            {
                var rows = await _db.ReadQueryAsync(
                    "SELECT CONVERT(varchar(34), CONVERT(binary(16), job_id), 1) AS hex, name FROM msdb.dbo.sysjobs",
                    new QueryOptions { Pool = PoolName.Msdb, Server = server });
                foreach (var r in rows) map[((string)r["hex"]!).ToUpperInvariant()] = (string)r["name"]!;
            }
            catch
            {
                /* no msdb access — show the raw program name */
            }
            _jobCache[server] = (Js.NowMs(), map);
            return map;
        }

        /// <summary>The Agent job (and step) a program name stands for, or null.</summary>
        public static string? JobNameOf(string? programName, Dictionary<string, string> jobs)
        {
            var m = JobStep.Match(programName ?? "");
            if (!m.Success) return null;
            return jobs.TryGetValue(m.Groups[1].Value.ToUpperInvariant(), out var name) ? $"{name} · step {m.Groups[2].Value}" : null;
        }

        /// <summary>Adds a jobName field worked out from the row's program name.</summary>
        public static Row WithJob(Row row, Dictionary<string, string> jobs, string field = "programName")
        {
            row["jobName"] = JobNameOf(row.GetValueOrDefault(field) as string, jobs);
            return row;
        }

        private static void Numbers(Row row, params string[] keys)
        {
            foreach (var k in keys) row[k] = Js.Num(row.GetValueOrDefault(k));
        }

        /* ---------------- Live: running, blocking, open transactions ---------------- */

        /// <summary>What is running right now, who blocks whom, and the open transactions.</summary>
        public async Task<object> LiveActivityAsync(string scope, bool showBackground, CancellationToken signal)
        {
            var all = scope == "server";
            SqlParam[] Params() => new[] { P.Bit("all", all) };
            var bg = showBackground ? "" : $"AND ISNULL(r.wait_type, '') NOT IN ({BackgroundWaitList})";

            var runningTask = _db.ReadQueryAsync(
                $@"SELECT r.session_id AS sessionId, DB_NAME(CASE WHEN st.objectid IS NOT NULL THEN st.dbid ELSE r.database_id END) AS db, r.status, r.command,
                     CASE WHEN st.objectid IS NOT NULL THEN OBJECT_SCHEMA_NAME(st.objectid, st.dbid) + '.' + OBJECT_NAME(st.objectid, st.dbid) END AS procName,
                     {Stmt("st.text", "r.statement_start_offset", "r.statement_end_offset")} AS statement,
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
                   WHERE r.session_id <> @@SPID AND s.is_user_process = 1 AND (@all = 1 OR r.database_id = DB_ID() OR (st.objectid IS NOT NULL AND st.dbid = DB_ID())) {bg}
                   ORDER BY r.total_elapsed_time DESC",
                new QueryOptions { Params = Params(), Signal = signal });
            // Every session that blocks someone (even when it is idle with an open transaction), with its last SQL.
            var blockersTask = _db.ReadQueryAsync(
                @"SELECT s.session_id AS sessionId, s.status, DB_NAME(s.database_id) AS db, s.login_name AS loginName, s.host_name AS hostName,
                     s.program_name AS programName, s.open_transaction_count AS openTransactions,
                     s.last_request_start_time AS lastRequestStart, s.last_request_end_time AS lastRequestEnd,
                     (SELECT COUNT(*) FROM sys.dm_exec_requests w WHERE w.blocking_session_id = s.session_id) AS blocking,
                     (SELECT NULLIF(MAX(rr.blocking_session_id), 0) FROM sys.dm_exec_requests rr WHERE rr.session_id = s.session_id) AS blockedBy,
                     (SELECT TOP 1 LEFT(t.text, 4000) FROM sys.dm_exec_connections c CROSS APPLY sys.dm_exec_sql_text(c.most_recent_sql_handle) t
                        WHERE c.session_id = s.session_id) AS lastSql
                   FROM sys.dm_exec_sessions s
                   WHERE s.session_id IN (SELECT r.blocking_session_id FROM sys.dm_exec_requests r WHERE r.blocking_session_id > 0 AND r.blocking_session_id <> r.session_id)",
                new QueryOptions { Signal = signal });
            var transactionsTask = _db.ReadQueryAsync(
                @"SELECT TOP (100) tst.session_id AS sessionId, s.status, DB_NAME(dt.database_id) AS db, at.name AS transactionName,
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
                   ORDER BY at.transaction_begin_time",
                new QueryOptions { Params = Params(), Signal = signal });
            var jobsTask = JobNamesAsync();
            var serverTask = _db.ReadQueryAsync(
                @"SELECT @@SERVERNAME AS server, CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(40)) AS version,
                     (SELECT sqlserver_start_time FROM sys.dm_os_sys_info) AS startedAt",
                new QueryOptions { Signal = signal });
            await Task.WhenAll(runningTask, blockersTask, transactionsTask, jobsTask, serverTask);
            var jobs = jobsTask.Result;

            var runningRows = runningTask.Result.Select(r => WithJob(Serialize.Fields(r), jobs)).ToList();
            foreach (var r in runningRows) Numbers(r, "elapsedMs", "cpuMs", "logicalReads", "reads", "writes", "rowsAffected", "waitMs");
            var blockerRows = blockersTask.Result.Select(r => WithJob(Serialize.Fields(r), jobs)).ToList();
            var txRows = transactionsTask.Result.Select(r => WithJob(Serialize.Fields(r), jobs)).ToList();
            foreach (var r in txRows) Numbers(r, "openSeconds", "logBytes", "locks");

            return new
            {
                scope,
                server = Serialize.Fields(serverTask.Result[0]),
                at = Serialize.FormatDate(DateTime.Now),
                running = runningRows,
                blockers = blockerRows,
                transactions = txRows,
            };
        }

        /* ---------------- Locks held / waited for ---------------- */

        /// <summary>Locks grouped by session, object and mode; waiting ones first.</summary>
        public async Task<List<Row>> LockSummaryAsync(string scope, CancellationToken signal)
        {
            var rows = await _db.ReadQueryAsync(
                @"SELECT TOP (500) x.sessionId, x.db, x.resourceType, x.mode, x.status, COUNT_BIG(*) AS locks,
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
                   ORDER BY CASE WHEN x.status = 'WAIT' THEN 0 ELSE 1 END, COUNT_BIG(*) DESC",
                new QueryOptions { Params = new[] { P.Bit("all", scope == "server") }, Signal = signal });
            var jobs = await JobNamesAsync();
            return rows.Select(r =>
            {
                var o = WithJob(Serialize.Fields(r), jobs);
                Numbers(o, "locks");
                return o;
            }).ToList();
        }

        /* ---------------- Deadlocks (system_health XE files) ---------------- */

        /// <summary>One deadlock with the processes involved.</summary>
        public sealed class Deadlock
        {
            /// <summary>Event timestamp, used as the id.</summary>
            public object? Id { get; init; }

            /// <summary>When it happened (server-local time).</summary>
            public object? At { get; init; }

            /// <summary>Objects the processes fought over.</summary>
            public object? Objects { get; init; }

            /// <summary>Databases involved.</summary>
            public List<string> Dbs { get; } = new();

            /// <summary>The victim and the winner(s).</summary>
            public List<Row> Processes { get; } = new();
        }

        private sealed record DeadlockCache(long At, DateTime ReadAt, List<Deadlock> Rows);

        /// <summary>Deadlocks from the system_health Extended Events files (cached 60 s per server).</summary>
        public async Task<object> DeadlocksAsync(string scope, bool refresh, CancellationToken signal)
        {
            var server = _targets.Current.Server;
            if (!_deadlockCache.TryGetValue(server, out var c) || refresh || Js.NowMs() - c.At > 60_000)
            {
                var rows = await _db.ReadQueryAsync(
                    @"WITH f AS (
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
                        CASE WHEN d.g.exist('deadlock/victim-list/victimProcess[@id = sql:column(""k.processKey"")]') = 1 THEN 1 ELSE 0 END AS isVictim,
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
                      ORDER BY d.at DESC",
                    new QueryOptions { Signal = signal });
                var jobs = await JobNamesAsync();
                // One entry per deadlock, with its processes.
                var map = new Dictionary<string, Deadlock>();
                var ordered = new List<Deadlock>();
                foreach (var raw in rows)
                {
                    var r = WithJob(Serialize.Fields(raw), jobs);
                    var id = Js.Str(r["id"]);
                    if (!map.TryGetValue(id, out var d))
                    {
                        d = new Deadlock { Id = r["id"], At = r["at"], Objects = r["objects"] };
                        map[id] = d;
                        ordered.Add(d);
                    }
                    if (r["db"] is { } dbValue && Js.Str(dbValue) is { Length: > 0 } dbName && !d.Dbs.Contains(dbName)) d.Dbs.Add(dbName);
                    d.Processes.Add(new Row
                    {
                        ["sessionId"] = r["sessionId"],
                        ["isVictim"] = r["isVictim"] is not null && Js.ToLong(r["isVictim"]) == 1,
                        ["db"] = r["db"],
                        ["loginName"] = r["loginName"],
                        ["hostName"] = r["hostName"],
                        ["programName"] = r["programName"],
                        ["jobName"] = r["jobName"],
                        ["lockMode"] = r["lockMode"],
                        ["waitResource"] = r["waitResource"],
                        ["waitMs"] = Js.Num(r["waitMs"]),
                        ["isolation"] = r["isolation"],
                        ["procName"] = r["procName"],
                        ["lineNumber"] = r["lineNumber"],
                        ["inputBuffer"] = r["inputBuffer"],
                    });
                }
                c = new DeadlockCache(Js.NowMs(), DateTime.Now, ordered);
                _deadlockCache[server] = c;
            }
            var db = _targets.Current.Database.ToLowerInvariant();
            var result = scope == "server" ? c.Rows : c.Rows.Where(d => d.Dbs.Any(x => x.ToLowerInvariant() == db)).ToList();
            return new
            {
                scope,
                rows = result,
                oldest = c.Rows.Count > 0 ? c.Rows[^1].At : null,
                readAt = Serialize.FormatDate(c.ReadAt),
            };
        }

        /* ---------------- Procedure execution stats ---------------- */

        /// <summary>Execution statistics per procedure since its plan was cached.</summary>
        public async Task<List<Row>> ProcedureStatsAsync(string scope, string sort, CancellationToken signal)
        {
            var order = ProcSorts.TryGetValue(sort, out var o) ? o : ProcSorts["total"];
            var rows = await _db.ReadQueryAsync(
                $@"SELECT TOP (300) DB_NAME(ps.database_id) AS db,
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
                   ORDER BY {order} DESC",
                new QueryOptions { Params = new[] { P.Bit("all", scope == "server") }, Signal = signal });
            return rows.Select(r =>
            {
                var row = Serialize.Fields(r);
                Numbers(row, "executions", "totalMs", "avgMs", "maxMs", "lastMs", "avgCpuMs", "avgReads", "avgWrites");
                return row;
            }).ToList();
        }

        /* ---------------- Procedure usage: last used, and by whom ---------------- */

        /// <summary>
        /// Every stored procedure of the selected database with when it was last used and by whom.
        /// "When" is the later of SQL Server's own last execution time (sys.dm_exec_procedure_stats, kept only
        /// while the plan stays cached) and the last time the activity history saw it. "By whom" comes from the
        /// activity history alone: SQL Server does not record who ran a procedure.
        /// </summary>
        public async Task<object> ProcedureUsageAsync(CancellationToken signal)
        {
            var target = _targets.Current;
            var rows = await _db.ReadQueryAsync(
                @"SELECT s.name + '.' + p.name AS procName, p.modify_date AS modifiedAt,
                         ps.lastRun, ps.executions, ps.cachedAt
                  FROM sys.procedures p
                  JOIN sys.schemas s ON s.schema_id = p.schema_id
                  LEFT JOIN (SELECT object_id, MAX(last_execution_time) AS lastRun, SUM(execution_count) AS executions, MIN(cached_time) AS cachedAt
                             FROM sys.dm_exec_procedure_stats WHERE database_id = DB_ID() GROUP BY object_id) ps ON ps.object_id = p.object_id
                  WHERE p.is_ms_shipped = 0
                  ORDER BY s.name, p.name",
                new QueryOptions { Signal = signal });

            string? serverStart = null;
            try
            {
                var info = await _db.ReadQueryAsync("SELECT sqlserver_start_time AS startedAt FROM sys.dm_os_sys_info", new QueryOptions { Signal = signal });
                serverStart = Js.Text(Serialize.Value(info.FirstOrDefault()?["startedAt"]));
            }
            catch (Exception err) when (err is not CancelledError)
            {
                /* not allowed to read it: the page just leaves the restart time out */
            }

            var historyOn = _config.History.Servers.Contains(target.Server.ToUpperInvariant());
            var seen = _history.ProcedureLastUse(target.Server.ToUpperInvariant(), target.Database);

            var procs = rows.Select(r =>
            {
                var name = (string)r["procName"]!;
                seen.TryGetValue(name.ToLowerInvariant(), out var h);
                var lastRun = Js.Text(Serialize.Value(r["lastRun"]));
                var lastSeen = h?["lastSeen"] as string;
                // Both are "yyyy-MM-dd HH:mm:ss.fff" in the SQL Server's local time, so text order is time order.
                var lastUsed = string.CompareOrdinal(lastRun ?? "", lastSeen ?? "") >= 0 ? lastRun : lastSeen;
                return (object)new
                {
                    procName = name,
                    modifiedAt = Serialize.Value(r["modifiedAt"]),
                    lastUsed,
                    lastRun,
                    executions = Js.ToNullableLong(r["executions"]),
                    cachedAt = Serialize.Value(r["cachedAt"]),
                    lastSeen,
                    lastLogin = h?["login"],
                    lastHost = h?["host"],
                    lastApp = h?["app"],
                    lastJob = h?["job"],
                    seen = h is null ? 0 : Js.ToLong(h["seen"]),
                    logins = h is null ? 0 : Js.ToLong(h["logins"]),
                };
            }).ToList();

            return new
            {
                database = target.Database,
                server = target.Server,
                historyOn,
                // How far back "used by" can go: rows older than the retention are deleted.
                retentionDays = _config.History.RetentionDays,
                historySince = _history.SampledSince(target.Server.ToUpperInvariant()),
                serverStart,
                rows = procs,
            };
        }
    }
}
