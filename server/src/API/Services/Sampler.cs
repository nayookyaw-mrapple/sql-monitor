using System.Collections.Concurrent;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using API.Configuration;
using API.Infrastructure;

namespace API.Services
{
    /// <summary>
    /// Activity sampler: every few seconds, look at each server in HISTORY_SERVERS and save to the local SQLite history
    ///  - what is executing right now (the same view as "Running now"), and
    ///  - the last batch each connected session finished since the previous poll, which catches quick queries.
    /// Runs all the time, viewer or not. Read-only: two SELECTs on system views per poll.
    ///
    /// This is a SAMPLE, not an audit: only the newest finished batch per session is visible, and a session that
    /// connects, runs and disconnects between two polls is never seen.
    /// The complete record comes from SQL Server Audit (see <see cref="AuditReader"/>).
    /// </summary>
    public sealed class Sampler
    {
        // The monitor's own connections (see Db.AppName) are left out so it doesn't log itself.
        private static readonly string SampleSql = $@"SELECT SYSDATETIME() AS now, r.session_id AS sessionId, r.start_time AS startTime,
            DB_NAME(CASE WHEN st.objectid IS NOT NULL THEN st.dbid ELSE r.database_id END) AS db, r.command,
            CASE WHEN st.objectid IS NOT NULL THEN OBJECT_SCHEMA_NAME(st.objectid, st.dbid) + '.' + OBJECT_NAME(st.objectid, st.dbid) END AS procName,
            {SqlActivityService.Stmt("st.text", "r.statement_start_offset", "r.statement_end_offset")} AS statement,
            r.statement_start_offset AS stmtStart,
            r.total_elapsed_time AS elapsedMs, r.cpu_time AS cpuMs, r.logical_reads AS logicalReads, r.writes, r.row_count AS rowsAffected,
            s.login_name AS loginName, s.host_name AS hostName, s.program_name AS programName,
            (SELECT TOP 1 c.client_net_address FROM sys.dm_exec_connections c WHERE c.session_id = r.session_id) AS clientAddress
          FROM sys.dm_exec_requests r
          JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id
          OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) st
          WHERE r.session_id <> @@SPID AND s.is_user_process = 1 AND ISNULL(s.program_name, '') <> '{Db.AppName}'
            AND ISNULL(r.wait_type, '') NOT IN ({SqlActivityService.BackgroundWaitList})";

        /// <summary>
        /// The last thing each connected session ran and has already finished. SQL Server keeps this per session, so a
        /// query far too quick to be "seen running" is still caught, as long as the session stays connected until the next
        /// poll (SSMS and pooled application connections do). Only the newest batch per session is available.
        /// A session with a request in flight is left to the running sample.
        /// </summary>
        private static readonly string LastSql = $@"SELECT SYSDATETIME() AS now, s.session_id AS sessionId, s.last_request_start_time AS lastStart, s.last_request_end_time AS lastEnd,
            DB_NAME(CASE WHEN t.objectid IS NOT NULL THEN t.dbid ELSE s.database_id END) AS db,
            CASE WHEN t.objectid IS NOT NULL THEN OBJECT_SCHEMA_NAME(t.objectid, t.dbid) + '.' + OBJECT_NAME(t.objectid, t.dbid) END AS procName,
            CASE WHEN t.objectid IS NULL THEN LEFT(t.text, 4000) END AS batch,
            s.login_name AS loginName, s.host_name AS hostName, s.program_name AS programName, c.client_net_address AS clientAddress
          FROM sys.dm_exec_sessions s
          JOIN sys.dm_exec_connections c ON c.session_id = s.session_id AND c.parent_connection_id IS NULL
          OUTER APPLY sys.dm_exec_sql_text(c.most_recent_sql_handle) t
          WHERE s.session_id <> @@SPID AND s.is_user_process = 1 AND ISNULL(s.program_name, '') <> '{Db.AppName}'
            AND s.last_request_end_time >= s.last_request_start_time
            AND NOT EXISTS (SELECT 1 FROM sys.dm_exec_requests rq WHERE rq.session_id = s.session_id)
            AND s.last_request_end_time >= DATEADD(millisecond, -@windowMs, SYSDATETIME())";

        private static readonly Regex StringLiteral = new("'(?:[^']|'')*'", RegexOptions.Compiled);
        private static readonly Regex LineComment = new(@"--[^\r\n]*", RegexOptions.Compiled);
        private static readonly Regex BlockComment = new(@"/\*[\s\S]*?\*/", RegexOptions.Compiled);
        private static readonly Regex WriteKeyword = new(@"\b(INSERT|UPDATE(?!\s+STATISTICS)|DELETE|MERGE|TRUNCATE)\b", RegexOptions.Compiled);
        private static readonly Regex ExecKeyword = new(@"\bEXEC(UTE)?\b", RegexOptions.Compiled);
        private static readonly Regex DdlKeyword = new(@"\b(CREATE|ALTER|DROP)\s+(TABLE|PROC|PROCEDURE|VIEW|FUNCTION|INDEX|TRIGGER|SCHEMA|DATABASE|TYPE|USER|LOGIN|ROLE)\b", RegexOptions.Compiled);
        private static readonly Regex SelectKeyword = new(@"\bSELECT\b", RegexOptions.Compiled);
        private static readonly Regex DdlCommand = new(@"^(CREATE|ALTER|DROP)\b", RegexOptions.Compiled);

        private const string Name = @"(?:\[[^\]]+\]|[#\w]+)(?:\s*\.\s*(?:\[[^\]]+\]|\w+)){0,3}";
        private static readonly Regex WriteTarget = new(
            @"\b(?:INSERT\s+(?:INTO\s+)?|UPDATE\s+|DELETE\s+(?:FROM\s+)?|MERGE\s+(?:INTO\s+)?|TRUNCATE\s+TABLE\s+|INTO\s+)(" + Name + ")",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);

        /// <summary>Second group: the alias, when one follows ("FROM ma_Heatmap_BinT hm").</summary>
        private static readonly Regex ReadSource = new(
            @"\b(?:FROM|JOIN|APPLY|USING)\s+(" + Name + @")(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);

        private static readonly Regex Brackets = new(@"[\[\]]", RegexOptions.Compiled);
        private static readonly Regex DotSpaces = new(@"\s*\.\s*", RegexOptions.Compiled);
        private static readonly Regex AllDigits = new(@"^\d+$", RegexOptions.Compiled);

        private static readonly HashSet<string> NotATable = new()
        {
            "TOP", "SELECT", "SET", "FROM", "INTO", "WITH", "VALUES", "EXEC", "EXECUTE", "OUTPUT", "DELETED", "INSERTED", "STATISTICS", "OPENJSON",
            "OPENXML", "OPENROWSET", "OPENQUERY", "STRING_SPLIT", "GENERATE_SERIES", "DISTINCT", "ALL",
        };

        private readonly MonitorConfig _config;
        private readonly Db _db;
        private readonly HistoryStore _store;
        private readonly SqlActivityService _activity;
        private readonly ILogger<Sampler> _logger;
        private readonly ConcurrentDictionary<string, SamplerState> _states = new();

        /// <summary>Creates the sampler.</summary>
        public Sampler(MonitorConfig config, Db db, HistoryStore store, SqlActivityService activity, ILogger<Sampler> logger)
        {
            _config = config;
            _db = db;
            _store = store;
            _activity = activity;
            _logger = logger;
        }

        /// <summary>
        /// Action of a whole batch, from its text. A change wins over a read ("SELECT …; UPDATE …" is an UPDATE), because
        /// who changed something is what the history is for. Text inside strings and comments is ignored.
        /// </summary>
        public static string ActionOfText(string? sqlText)
        {
            if (string.IsNullOrEmpty(sqlText)) return "OTHER";
            var text = BlockComment.Replace(LineComment.Replace(StringLiteral.Replace(sqlText, "''"), " "), " ").ToUpperInvariant();
            var write = WriteKeyword.Match(text);
            if (write.Success) return write.Groups[1].Value;
            if (ExecKeyword.IsMatch(text)) return "EXECUTE";
            if (DdlKeyword.IsMatch(text)) return "DDL";
            if (SelectKeyword.IsMatch(text)) return "SELECT";
            return "OTHER";
        }

        /// <summary>INSERT / UPDATE / DELETE / MERGE / SELECT / EXECUTE / TRUNCATE / DDL / OTHER, from SQL Server's own command name.</summary>
        public static string ActionOf(string? command)
        {
            var c = (command ?? "").ToUpperInvariant();
            if (c is "INSERT" or "BULK INSERT" or "SELECT INTO") return "INSERT";
            if (c is "UPDATE" or "DELETE" or "MERGE" or "SELECT" or "EXECUTE") return c;
            if (c == "TRUNCATE TABLE") return "TRUNCATE";
            if (DdlCommand.IsMatch(c)) return "DDL";
            return "OTHER";
        }

        /// <summary>
        /// Best-effort list of the tables a statement names, write target first. It is a text match, so it also picks
        /// up aliases, views and functions, and it cannot see inside dynamic SQL or nested procedures.
        /// </summary>
        public static string? TablesIn(string? sqlText)
        {
            if (string.IsNullOrEmpty(sqlText)) return null;
            var text = BlockComment.Replace(LineComment.Replace(StringLiteral.Replace(sqlText, "''"), " "), " ");
            // "UPDATE hm SET … FROM ma_Heatmap_BinT hm": hm is an alias, not a table.
            var aliases = new HashSet<string>(ReadSource.Matches(text).Where(m => m.Groups[2].Success && m.Groups[2].Value.Length > 0).Select(m => m.Groups[2].Value.ToLowerInvariant()));
            var seen = new HashSet<string>();
            var found = new List<string>();
            foreach (var re in new[] { WriteTarget, ReadSource })
            {
                foreach (Match m in re.Matches(text))
                {
                    var name = DotSpaces.Replace(Brackets.Replace(m.Groups[1].Value, ""), ".");
                    var lower = name.ToLowerInvariant();
                    if (NotATable.Contains(name.ToUpperInvariant()) || AllDigits.IsMatch(name) || seen.Contains(lower) || aliases.Contains(lower)) continue;
                    seen.Add(lower);
                    found.Add(name);
                    if (found.Count >= 12) break;
                }
            }
            return found.Count > 0 ? Js.Left(string.Join(", ", found), 500) : null;
        }

        private sealed class SamplerState
        {
            public string? LastPollAt;
            public string? LastError;
            public long Polls;
            /// <summary>When the previous poll was made (this machine's clock), to size the "finished since" window.</summary>
            public long LastPollMs;
            /// <summary>Per session: start time of the newest request already saved, so it isn't saved twice.</summary>
            public readonly Dictionary<long, string> SavedStart = new();
        }

        private static string Sha1Hex(string text) => Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();

        private static DateTime? Date(object? v) => v is DateTime d ? d : null;

        /// <summary>Date truncated to whole milliseconds (the precision the history keeps).</summary>
        private static DateTime Ms(DateTime d) => new(d.Ticks - d.Ticks % TimeSpan.TicksPerMillisecond, d.Kind);

        private async Task SampleOnceAsync(string server)
        {
            var st = _states[server];
            // Look back to the previous poll plus a margin; anything already saved is skipped below.
            var windowMs = Math.Min(10 * 60_000, (st.LastPollMs != 0 ? Js.NowMs() - st.LastPollMs : _config.History.SampleMs) + 3000);
            var pollStarted = Js.NowMs();
            var rowsTask = _db.ReadQueryAsync(SampleSql, new QueryOptions { Pool = PoolName.Master, Server = server });
            var lastTask = _db.ReadQueryAsync(LastSql, new QueryOptions { Pool = PoolName.Master, Server = server, Params = new[] { P.Int("windowMs", (int)windowMs) } });
            var jobsTask = _activity.JobNamesAsync(server);
            await Task.WhenAll(rowsTask, lastTask, jobsTask);
            var rows = rowsTask.Result;
            var last = lastTask.Result;
            var jobs = jobsTask.Result;

            st.LastPollMs = pollStarted;
            st.Polls++;
            st.LastError = null;
            st.LastPollAt = Serialize.FormatDate(Date(rows.FirstOrDefault()?["now"]) ?? Date(last.FirstOrDefault()?["now"]) ?? DateTime.Now);

            // Finished requests: one row each, timed at the moment the request ended.
            var finished = new List<SampleRow>();
            var running = new Dictionary<long, string?>();
            foreach (var r in rows) running[Js.ToLong(r["sessionId"])] = Date(r["startTime"]) is { } start ? Serialize.FormatDate(start) : null;
            foreach (var r in last)
            {
                var lastStart = Date(r["lastStart"]);
                var lastEnd = Date(r["lastEnd"]);
                var batch = r["batch"] as string;
                var procName = r["procName"] as string;
                if (lastStart is null || lastEnd is null || (string.IsNullOrEmpty(batch) && string.IsNullOrEmpty(procName))) continue;
                var sessionId = Js.ToLong(r["sessionId"]);
                var requestStart = Serialize.FormatDate(lastStart.Value);
                // Already saved, or the session has moved on to a new request that the running sample covers.
                if ((st.SavedStart.TryGetValue(sessionId, out var saved) && saved == requestStart) || running.ContainsKey(sessionId)) continue;
                st.SavedStart[sessionId] = requestStart;
                var endedAt = Serialize.FormatDate(lastEnd.Value);
                var loginName = r["loginName"] as string;
                var hostName = r["hostName"] as string;
                var programName = r["programName"] as string;
                var db = r["db"] as string;
                finished.Add(new SampleRow
                {
                    // The same batch from the same login, host and app within one clock hour is one row with a count: an application
                    // repeating a query every few seconds would otherwise add hundreds of thousands of rows a day.
                    Key = string.Join('|', server, "L", endedAt.Substring(0, 13), Sha1Hex(string.Join('\u0001', loginName ?? "", hostName ?? "", programName ?? "", db ?? "", procName ?? "", batch ?? ""))),
                    Capture = "last",
                    SeenAt = endedAt,
                    Db = db,
                    SessionId = sessionId,
                    RequestStart = requestStart,
                    // A procedure called directly (RPC): only its name is known, not the statements inside it.
                    Action = !string.IsNullOrEmpty(procName) ? "EXECUTE" : ActionOfText(batch),
                    Command = null,
                    ProcName = procName,
                    Statement = batch,
                    Tables = TablesIn(batch),
                    LoginName = loginName,
                    HostName = hostName,
                    ClientAddress = r["clientAddress"] as string,
                    ProgramName = programName,
                    JobName = SqlActivityService.JobNameOf(programName, jobs),
                    ElapsedMs = Math.Max(0, (long)(Ms(lastEnd.Value) - Ms(lastStart.Value)).TotalMilliseconds),
                    CpuMs = null,
                    LogicalReads = null,
                    Writes = null,
                    RowsAffected = null,
                });
            }
            // Forget sessions that have gone, so the map doesn't grow for ever (session ids are reused).
            if (st.SavedStart.Count > 5000) st.SavedStart.Clear();
            // A request seen running is saved by the running sample; remember it so its "finished" twin is skipped.
            foreach (var (sessionId, start) in running)
            {
                if (!string.IsNullOrEmpty(start)) st.SavedStart[sessionId] = start;
            }
            _store.SaveSamples(server, finished);

            if (rows.Count == 0) return;
            var seenAt = Serialize.FormatDate(Date(rows[0]["now"]) ?? DateTime.Now);
            var samples = rows.Select(r =>
            {
                var requestStart = Date(r["startTime"]) is { } start ? Serialize.FormatDate(start) : null;
                var programName = r["programName"] as string;
                var procName = r["procName"] as string;
                var statement = r["statement"] as string;
                var command = r["command"] as string;
                var sessionId = Js.ToLong(r["sessionId"]);
                return new SampleRow
                {
                    Key = string.Join('|', server, sessionId.ToString(CultureInfo.InvariantCulture), requestStart ?? "", procName ?? "", Js.ToLong(r["stmtStart"]).ToString(CultureInfo.InvariantCulture)),
                    Capture = "running",
                    SeenAt = seenAt,
                    Db = r["db"] as string,
                    SessionId = sessionId,
                    RequestStart = requestStart,
                    Action = ActionOf(command),
                    Command = command,
                    ProcName = procName,
                    Statement = statement,
                    Tables = TablesIn(statement),
                    LoginName = r["loginName"] as string,
                    HostName = r["hostName"] as string,
                    ClientAddress = r["clientAddress"] as string,
                    ProgramName = programName,
                    JobName = SqlActivityService.JobNameOf(programName, jobs),
                    ElapsedMs = Js.ToNullableLong(r["elapsedMs"]),
                    CpuMs = Js.ToNullableLong(r["cpuMs"]),
                    LogicalReads = Js.ToNullableLong(r["logicalReads"]),
                    Writes = Js.ToNullableLong(r["writes"]),
                    RowsAffected = Js.ToNullableLong(r["rowsAffected"]),
                };
            }).ToList();
            _store.SaveSamples(server, samples);
        }

        private async Task LoopAsync(string server, CancellationToken stop)
        {
            var st = _states[server];
            while (!stop.IsCancellationRequested)
            {
                try
                {
                    await SampleOnceAsync(server);
                }
                catch (Exception err)
                {
                    var msg = err.Message;
                    if (st.LastError != msg) _logger.LogError("[sampler] {Server}: {Message}", server, msg);
                    st.LastError = msg;
                }
                try
                {
                    // After a failure wait longer, so an unreachable server isn't hammered.
                    await Task.Delay(st.LastError != null ? Math.Max(30_000, _config.History.SampleMs) : _config.History.SampleMs, stop);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
            }
        }

        /// <summary>Starts sampling every server in HISTORY_SERVERS; returns the running loops.</summary>
        public List<Task> Start(CancellationToken stop)
        {
            var loops = new List<Task>();
            foreach (var server in _config.History.Servers)
            {
                _states[server] = new SamplerState();
                loops.Add(Task.Run(() => LoopAsync(server, stop), CancellationToken.None));
            }
            if (_config.History.Servers.Count > 0)
            {
                _logger.LogInformation("[sampler] sampling {Servers} every {Interval} ms", string.Join(", ", _config.History.Servers), _config.History.SampleMs);
            }
            return loops;
        }

        /// <summary>State of the sampler for a server, for the UI.</summary>
        public object Status(string server)
        {
            _states.TryGetValue(server.ToUpperInvariant(), out var st);
            return new { enabled = st != null, intervalMs = _config.History.SampleMs, lastPollAt = st?.LastPollAt, lastError = st?.LastError };
        }
    }
}
