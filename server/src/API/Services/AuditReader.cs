using System.Collections.Concurrent;
using API.Configuration;
using API.Infrastructure;

namespace API.Services
{
    /// <summary>
    /// Audit reader: copies new SQL Server Audit records into the local SQLite history.
    ///
    /// SQL Monitor never creates or changes the audit. A DBA sets it up once per server with the script from
    /// <see cref="AuditSetupScript"/> (shown on the Audit history tab); until then this just reports "not set up".
    /// Reading uses sys.fn_get_audit_file, a plain SELECT.
    /// </summary>
    public sealed class AuditReader
    {
        private const int Batch = 5000;

        /// <summary>Batches per poll, so catching up on a large backlog doesn't hold one long loop.</summary>
        private const int MaxBatches = 20;

        private static readonly Dictionary<string, string> Actions = new()
        {
            ["IN"] = "INSERT",
            ["UP"] = "UPDATE",
            ["DL"] = "DELETE",
            ["EX"] = "EXECUTE",
            ["SL"] = "SELECT",
            ["RF"] = "REFERENCES",
        };

        private readonly MonitorConfig _config;
        private readonly Db _db;
        private readonly HistoryStore _store;
        private readonly ILogger<AuditReader> _logger;
        private readonly ConcurrentDictionary<string, AuditState> _states = new();

        /// <summary>Creates the reader.</summary>
        public AuditReader(MonitorConfig config, Db db, HistoryStore store, ILogger<AuditReader> logger)
        {
            _config = config;
            _db = db;
            _store = store;
            _logger = logger;
        }

        private sealed class AuditState
        {
            /// <summary>null = not looked up yet.</summary>
            public bool? Found;
            public bool? AuditEnabled;
            public string? Pattern;
            public string? LastReadAt;
            public string? LastError;
            public long LastLookup;
            public bool LookedUp;
        }

        /// <summary>Where the audit writes its files: from HISTORY_AUDIT_FILE_PATTERN, or looked up by audit name (rechecked every 5 min).</summary>
        private async Task LocateAsync(string server, AuditState st)
        {
            if (st.Found != null && st.LookedUp && Js.NowMs() - st.LastLookup < 5 * 60_000) return;
            st.LastLookup = Js.NowMs();
            st.LookedUp = true;
            if (!string.IsNullOrEmpty(_config.History.AuditFilePattern))
            {
                st.Found = true;
                st.Pattern = _config.History.AuditFilePattern;
                return;
            }
            var rows = await _db.ReadQueryAsync(
                "SELECT log_file_path AS path, is_state_enabled AS enabled FROM sys.server_file_audits WHERE name = @name",
                new QueryOptions { Pool = PoolName.Master, Server = server, Params = new[] { P.NVarChar("name", 128, _config.History.AuditName) } });
            if (rows.Count == 0)
            {
                st.Found = false;
                st.Pattern = null;
                st.AuditEnabled = null;
                return;
            }
            var raw = (string)rows[0]["path"]!;
            var path = raw.EndsWith('\\') || raw.EndsWith('/') ? raw : $"{raw}\\";
            st.Found = true;
            st.AuditEnabled = Js.Truthy(rows[0]["enabled"]);
            st.Pattern = $"{path}{_config.History.AuditName}_*.sqlaudit";
        }

        private static string? Text(Row r, string column, int max = 400) =>
            r.GetValueOrDefault(column) is string s && s != "" ? Js.Left(s, max) : null;

        private static AuditRow? ToAuditRow(Row r)
        {
            var actionId = (r.GetValueOrDefault("action_id") is { } a ? Js.Str(a) : "").Trim();
            // "Audit session changed" marks the audit itself starting/stopping, not user activity.
            if (actionId.Length == 0 || actionId == "AUSC") return null;
            var eventLocal = r.GetValueOrDefault("eventLocal");
            var succeeded = r.GetValueOrDefault("succeeded");
            return new AuditRow
            {
                EventUtc = Js.Str(r.GetValueOrDefault("eventUtc")),
                EventTime = eventLocal is DateTime d ? Serialize.FormatDate(d) : Js.Str(eventLocal),
                Sequence = Js.ToLong(r.GetValueOrDefault("sequence_number")),
                ActionId = actionId,
                Action = Actions.TryGetValue(actionId, out var name) ? name : actionId,
                Succeeded = succeeded is true || (succeeded is not null and not bool && Js.ToLong(succeeded) == 1),
                SessionId = Js.ToNullableLong(r.GetValueOrDefault("session_id")),
                Db = Text(r, "database_name"),
                SchemaName = Text(r, "schema_name"),
                ObjectName = Text(r, "object_name"),
                ClassType = Text(r, "class_type")?.Trim(),
                LoginName = Text(r, "server_principal_name"),
                SessionLogin = Text(r, "session_server_principal_name"),
                DbUser = Text(r, "database_principal_name"),
                // These three only exist on newer SQL Server versions.
                HostName = Text(r, "host_name"),
                ClientIp = Text(r, "client_ip"),
                ProgramName = Text(r, "application_name"),
                Statement = Text(r, "statement", 4000),
            };
        }

        private Task<List<Row>> ReadBatchAsync(string server, string pattern, string? fileName, string? offset)
        {
            return _db.ReadQueryAsync(
                @"SELECT TOP (@n) CONVERT(varchar(27), a.event_time, 126) AS eventUtc,
                    CONVERT(datetime2(3), SWITCHOFFSET(CONVERT(datetimeoffset, a.event_time), DATEPART(TZOFFSET, SYSDATETIMEOFFSET()))) AS eventLocal,
                    a.*
                  FROM sys.fn_get_audit_file(@pattern, @file, @offset) a",
                new QueryOptions
                {
                    Pool = PoolName.Master,
                    Server = server,
                    Params = new[]
                    {
                        P.Int("n", Batch),
                        P.NVarChar("pattern", 260, pattern),
                        P.NVarChar("file", 260, fileName),
                        P.BigInt("offset", offset is null ? null : Js.ParseInt(offset)),
                    },
                });
        }

        private async Task IngestAsync(string server)
        {
            var st = _states[server];
            await LocateAsync(server, st);
            if (st.Found != true || string.IsNullOrEmpty(st.Pattern)) return;

            var pos = _store.GetAuditPosition(server);
            for (var i = 0; i < MaxBatches; i++)
            {
                List<Row> rows;
                try
                {
                    rows = await ReadBatchAsync(server, st.Pattern, pos.FileName, pos.Offset);
                }
                catch
                {
                    // The file we stopped in was rolled over and deleted: start again from the oldest file (duplicates are ignored).
                    if (!string.IsNullOrEmpty(pos.FileName) && i == 0)
                    {
                        rows = await ReadBatchAsync(server, st.Pattern, null, null);
                        pos = (null, null);
                    }
                    else
                    {
                        throw;
                    }
                }
                if (rows.Count == 0) break;
                _store.SaveAuditEvents(server, rows.Select(ToAuditRow).Where(r => r != null).Select(r => r!).ToList());
                var last = rows[^1];
                (string? FileName, string? Offset) next = (Js.Str(last.GetValueOrDefault("file_name")), Js.Str(last.GetValueOrDefault("audit_file_offset")));
                var stuck = next.FileName == pos.FileName && next.Offset == pos.Offset;
                pos = next;
                _store.SetAuditPosition(server, pos.FileName, pos.Offset);
                if (rows.Count < Batch || stuck) break;
            }
            st.LastReadAt = Serialize.FormatDate(DateTime.Now);
            st.LastError = null;
        }

        private async Task LoopAsync(string server, CancellationToken stop)
        {
            var st = _states[server];
            while (!stop.IsCancellationRequested)
            {
                try
                {
                    await IngestAsync(server);
                }
                catch (Exception err)
                {
                    var msg = err.Message;
                    if (st.LastError != msg) _logger.LogError("[audit] {Server}: {Message}", server, msg);
                    st.LastError = msg;
                }
                try
                {
                    await Task.Delay(_config.History.AuditPollMs, stop);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
            }
        }

        /// <summary>Starts reading the audit of every server in HISTORY_SERVERS; returns the running loops.</summary>
        public List<Task> Start(CancellationToken stop)
        {
            var loops = new List<Task>();
            foreach (var server in _config.History.Servers)
            {
                _states[server] = new AuditState();
                loops.Add(Task.Run(() => LoopAsync(server, stop), CancellationToken.None));
            }
            return loops;
        }

        /// <summary>State of the audit reader for a server, for the UI.</summary>
        public object Status(string server)
        {
            _states.TryGetValue(server.ToUpperInvariant(), out var st);
            return new
            {
                enabled = st != null,
                auditName = _config.History.AuditName,
                found = st?.Found,
                auditEnabled = st?.AuditEnabled,
                filePattern = st?.Pattern,
                lastReadAt = st?.LastReadAt,
                lastError = st?.LastError,
            };
        }

        private static string Ident(string v) => $"[{v.Replace("]", "]]")}]";

        /// <summary>
        /// The one-time setup a DBA runs. SQL Monitor only displays this text; it never runs it.
        /// Covers every table and procedure in the database (INSERT/UPDATE/DELETE/EXECUTE by anyone).
        /// </summary>
        public string AuditSetupScript(string database, string login)
        {
            var audit = Ident(_config.History.AuditName);
            var spec = Ident($"{_config.History.AuditName}_{database}");
            return string.Join("\n", new[]
            {
                "-- SQL Monitor audit setup. Run once, as a sysadmin. SQL Monitor itself never runs this.",
                $"-- Records every INSERT / UPDATE / DELETE / EXECUTE on every table and procedure in {database}.",
                "-- ON_FAILURE = CONTINUE: if the audit cannot write, applications keep working.",
                "-- Disk use is capped at MAXSIZE x MAX_ROLLOVER_FILES (about 10 GB below); the oldest file is then reused.",
                "",
                "-- 1) Once per SQL Server: where the records are written. Change FILEPATH to an existing folder.",
                "USE master;",
                $"CREATE SERVER AUDIT {audit}",
                "  TO FILE (FILEPATH = N'D:\\SQLAudit\\', MAXSIZE = 256 MB, MAX_ROLLOVER_FILES = 40, RESERVE_DISK_SPACE = OFF)",
                "  WITH (QUEUE_DELAY = 1000, ON_FAILURE = CONTINUE)",
                "  WHERE schema_name <> 'sys';   -- leaves out system procedures such as sp_executesql",
                $"ALTER SERVER AUDIT {audit} WITH (STATE = ON);",
                "",
                "-- 2) Once per database to audit (repeat this block for other databases).",
                $"USE {Ident(database)};",
                $"CREATE DATABASE AUDIT SPECIFICATION {spec}",
                $"  FOR SERVER AUDIT {audit}",
                $"  ADD (INSERT, UPDATE, DELETE, EXECUTE ON DATABASE::{Ident(database)} BY [public])",
                "  WITH (STATE = ON);",
                "",
                "-- 3) Let SQL Monitor read the audit files (SQL Server 2022+).",
                $"--    On older versions use: GRANT CONTROL SERVER TO {Ident(login)};",
                "USE master;",
                $"GRANT VIEW SERVER SECURITY AUDIT TO {Ident(login)};",
                "",
                "-- To stop auditing later:",
                $"--   USE {Ident(database)}; ALTER DATABASE AUDIT SPECIFICATION {spec} WITH (STATE = OFF); DROP DATABASE AUDIT SPECIFICATION {spec};",
                $"--   USE master; ALTER SERVER AUDIT {audit} WITH (STATE = OFF); DROP SERVER AUDIT {audit};",
                "",
            });
        }
    }
}
