using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using API.Configuration;
using API.Infrastructure;
using Microsoft.Data.Sqlite;

namespace API.Services
{
    /// <summary>A row for the sampled activity log.</summary>
    public sealed class SampleRow
    {
        /// <summary>Identifies one statement of one request, so repeated sightings update the same row.</summary>
        public required string Key { get; init; }

        /// <summary>running = seen while executing; last = the session's last finished batch, picked up after the fact.</summary>
        public required string Capture { get; init; }

        /// <summary>When it was seen (running) or when it ended (last).</summary>
        public required string SeenAt { get; init; }

        /// <summary>Database.</summary>
        public string? Db { get; init; }

        /// <summary>Session id.</summary>
        public long SessionId { get; init; }

        /// <summary>When the request started.</summary>
        public string? RequestStart { get; init; }

        /// <summary>INSERT, UPDATE, DELETE, …</summary>
        public required string Action { get; init; }

        /// <summary>SQL Server's command name.</summary>
        public string? Command { get; init; }

        /// <summary>Stored procedure.</summary>
        public string? ProcName { get; init; }

        /// <summary>Statement or batch text.</summary>
        public string? Statement { get; init; }

        /// <summary>Tables named in the statement.</summary>
        public string? Tables { get; init; }

        /// <summary>Login.</summary>
        public string? LoginName { get; init; }

        /// <summary>Client machine.</summary>
        public string? HostName { get; init; }

        /// <summary>Client IP address.</summary>
        public string? ClientAddress { get; init; }

        /// <summary>Application name.</summary>
        public string? ProgramName { get; init; }

        /// <summary>Agent job and step.</summary>
        public string? JobName { get; init; }

        /// <summary>Duration.</summary>
        public long? ElapsedMs { get; init; }

        /// <summary>CPU time.</summary>
        public long? CpuMs { get; init; }

        /// <summary>Logical reads.</summary>
        public long? LogicalReads { get; init; }

        /// <summary>Writes.</summary>
        public long? Writes { get; init; }

        /// <summary>Rows affected.</summary>
        public long? RowsAffected { get; init; }
    }

    /// <summary>A record copied from SQL Server Audit.</summary>
    public sealed class AuditRow
    {
        /// <summary>UTC time with full precision, only used to tell records apart.</summary>
        public required string EventUtc { get; init; }

        /// <summary>Server-local time.</summary>
        public required string EventTime { get; init; }

        /// <summary>Sequence number inside the event.</summary>
        public long Sequence { get; init; }

        /// <summary>SQL Server's action id (IN, UP, DL, …).</summary>
        public required string ActionId { get; init; }

        /// <summary>INSERT, UPDATE, DELETE, …</summary>
        public required string Action { get; init; }

        /// <summary>The statement succeeded.</summary>
        public bool Succeeded { get; init; }

        /// <summary>Session id.</summary>
        public long? SessionId { get; init; }

        /// <summary>Database.</summary>
        public string? Db { get; init; }

        /// <summary>Schema of the object.</summary>
        public string? SchemaName { get; init; }

        /// <summary>Object (table, procedure).</summary>
        public string? ObjectName { get; init; }

        /// <summary>Kind of object.</summary>
        public string? ClassType { get; init; }

        /// <summary>Login.</summary>
        public string? LoginName { get; init; }

        /// <summary>Login of the session.</summary>
        public string? SessionLogin { get; init; }

        /// <summary>Database user.</summary>
        public string? DbUser { get; init; }

        /// <summary>Client machine.</summary>
        public string? HostName { get; init; }

        /// <summary>Client IP address.</summary>
        public string? ClientIp { get; init; }

        /// <summary>Application name.</summary>
        public string? ProgramName { get; init; }

        /// <summary>Statement text.</summary>
        public string? Statement { get; init; }
    }

    /// <summary>Filters and paging of the history logs.</summary>
    public sealed class HistoryFilter
    {
        /// <summary>Server.</summary>
        public required string Server { get; init; }

        /// <summary>Only this database; null = the whole server.</summary>
        public string? Db { get; init; }

        /// <summary>Start of the range.</summary>
        public string? From { get; init; }

        /// <summary>End of the range.</summary>
        public string? To { get; init; }

        /// <summary>Only this action.</summary>
        public string? Action { get; init; }

        /// <summary>Text to find anywhere.</summary>
        public string? Search { get; init; }

        /// <summary>Text to find in the "who" columns only (login, host, app, job, client address).</summary>
        public string? Who { get; init; }

        /// <summary>Kind of login: agent, user, maui or other.</summary>
        public string? WhoType { get; init; }

        /// <summary>Only this login (exact, case-insensitive).</summary>
        public string? Login { get; init; }

        /// <summary>Leave this login out, e.g. a label printer account that runs every few seconds.</summary>
        public string? NotLogin { get; init; }

        /// <summary>Only this application (exact, case-insensitive), as worked out by AppName().</summary>
        public string? App { get; init; }

        /// <summary>Sampled log only: how the row was captured (running or last).</summary>
        public string? Capture { get; init; }

        /// <summary>Page, from 1.</summary>
        public int Page { get; init; }

        /// <summary>Rows per page.</summary>
        public int PageSize { get; init; }
    }

    /// <summary>A page of history rows.</summary>
    public sealed record HistoryPage(List<Row> Rows, long Total, long TotalPages);

    /// <summary>
    /// Local SQLite file that keeps the activity history (who ran what). This is the only thing SQL Monitor
    /// writes to, and it lives on the machine running the server — never on SQL Server.
    ///
    ///  - sampled_activity: what the sampler saw in "Running now" (incomplete by nature: fast statements are missed).
    ///  - audit_event:      records copied from SQL Server Audit files (complete, when a DBA has set the audit up).
    ///
    /// Times are stored as "YYYY-MM-DD HH:mm:ss.SSS" in the SQL Server's local time, like everywhere else in the app.
    /// </summary>
    public sealed class HistoryStore : IDisposable
    {
        /// <summary>A Kubernetes pod name: service, replica set hash, pod id, e.g. transfer-api-58b56785cc-hn82t.</summary>
        private static readonly Regex PodHost = new("^([a-z0-9][a-z0-9.-]*?)-[a-z0-9]{6,10}-[a-z0-9]{5}$", RegexOptions.Compiled);

        /// <summary>An application name that is really a list of settings, e.g. "siteId=3&amp;season=2026" or "SiteID=6".</summary>
        private static readonly Regex SettingsName = new(@"^[A-Za-z0-9_]+=[^&]*(&[A-Za-z0-9_]+=[^&]*)*$", RegexOptions.Compiled);

        private static readonly Regex SqlAgentProgram = new("^SQLAgent", RegexOptions.IgnoreCase | RegexOptions.Compiled);
        private static readonly Regex SqlAgentLogin = new("SQLSERVERAGENT", RegexOptions.IgnoreCase | RegexOptions.Compiled);
        private static readonly Regex NamedApp = new("(?:^|&)App=([^&]+)", RegexOptions.IgnoreCase | RegexOptions.Compiled);
        private static readonly Regex LikeSpecial = new(@"[\\%_]", RegexOptions.Compiled);

        /// <summary>SQL Agent job steps: by program name, or by the Agent service account.</summary>
        private const string IsAgent = "(COALESCE(program_name, '') LIKE 'SQLAgent%' OR COALESCE(login_name, '') LIKE '%SQLSERVERAGENT%')";

        /// <summary>Windows domain accounts (DOMAIN\name), leaving out the built-in NT SERVICE / NT AUTHORITY accounts.</summary>
        private const string IsUser = @"(COALESCE(login_name, '') LIKE '%\%' AND COALESCE(login_name, '') NOT LIKE 'NT %' AND NOT " + IsAgent + ")";

        private static readonly Dictionary<string, string> WhoTypes = new()
        {
            ["agent"] = IsAgent,
            ["user"] = IsUser,
            // The MAUI .NET services: they connect with the "Core Microsoft SqlClient Data Provider" application name.
            ["maui"] = "COALESCE(program_name, '') LIKE 'Core Microsoft SqlClient%'",
            ["other"] = $"(NOT {IsAgent} AND NOT {IsUser})",
        };

        private readonly MonitorConfig _config;
        private readonly object _sync = new();
        private SqliteConnection? _handle;

        /// <summary>Creates the store; the file is opened on first use.</summary>
        public HistoryStore(MonitorConfig config) => _config = config;

        /// <summary>
        /// The application a connection came from, for the App column and filter:
        ///  - a service running in Kubernetes: the service name, taken from the pod name it connected from (the pod
        ///    id changes on every deploy, the service name does not);
        ///  - a SQL Agent job step: "SQL Agent";
        ///  - a client that sends its settings as the application name ("SiteID=2&amp;App=CARLA"): the App value, so
        ///    the same program at different sites counts as one application;
        ///  - settings with no App value ("siteId=3&amp;season=2026"): nothing, because that does not say which program it is;
        ///  - anything else: the application name the client gave SQL Server.
        /// </summary>
        public static string? AppName(string? programName, string? hostName, string? loginName)
        {
            var program = programName?.Trim() ?? "";
            if (SqlAgentProgram.IsMatch(program) || SqlAgentLogin.IsMatch(loginName ?? "")) return "SQL Agent";
            var pod = PodHost.Match(hostName?.Trim() ?? "");
            if (pod.Success) return pod.Groups[1].Value;
            var named = NamedApp.Match(program);
            if (named.Success)
            {
                var app = named.Groups[1].Value.Trim();
                return app.Length > 0 ? app : null;
            }
            if (SettingsName.IsMatch(program)) return null;
            return program.Length > 0 ? program : null;
        }

        /// <summary>Full path of the SQLite file.</summary>
        public string HistoryDbPath() =>
            Path.IsPathRooted(_config.History.DbPath) ? _config.History.DbPath : Path.GetFullPath(Path.Combine(ServerPaths.Root, _config.History.DbPath));

        /* ---------------- Plumbing ---------------- */

        private static SqliteCommand Command(SqliteConnection d, string sql, params object?[] args)
        {
            var cmd = d.CreateCommand();
            // Positional "?" placeholders become named parameters, in order.
            var text = new StringBuilder(sql.Length + args.Length * 3);
            var index = 0;
            foreach (var ch in sql)
            {
                if (ch == '?') text.Append("@p").Append(index++);
                else text.Append(ch);
            }
            cmd.CommandText = text.ToString();
            for (var i = 0; i < index; i++) cmd.Parameters.AddWithValue("@p" + i, i < args.Length ? args[i] ?? DBNull.Value : DBNull.Value);
            return cmd;
        }

        private static void Bind(SqliteCommand cmd, params object?[] args)
        {
            for (var i = 0; i < args.Length; i++) cmd.Parameters[i].Value = args[i] ?? DBNull.Value;
        }

        private static int Exec(SqliteConnection d, string sql, params object?[] args)
        {
            using var cmd = Command(d, sql, args);
            return cmd.ExecuteNonQuery();
        }

        private static List<Row> All(SqliteConnection d, string sql, params object?[] args)
        {
            using var cmd = Command(d, sql, args);
            using var reader = cmd.ExecuteReader();
            var rows = new List<Row>();
            while (reader.Read())
            {
                var row = new Row(reader.FieldCount);
                for (var i = 0; i < reader.FieldCount; i++) row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
                rows.Add(row);
            }
            return rows;
        }

        private static Row? Get(SqliteConnection d, string sql, params object?[] args) => All(d, sql, args).FirstOrDefault();

        /// <summary>
        /// Add the app column to a table created before it existed, and fill it in for rows saved without one.
        /// Safe to run on every start: an interrupted first run is simply finished by the next one.
        /// </summary>
        private static void AddAppColumn(SqliteConnection d, string table)
        {
            var cols = All(d, $"PRAGMA table_info({table})");
            if (!cols.Any(c => (string?)c["name"] == "app")) Exec(d, $"ALTER TABLE {table} ADD COLUMN app TEXT");
            // Rows saved while a bare settings string ("SiteID=6") still counted as an app name: clear those.
            var settings = All(d, $"SELECT DISTINCT app FROM {table} WHERE app LIKE '%=%'")
                .Select(r => r["app"] as string)
                .Where(a => a != null && SettingsName.IsMatch(a))
                .ToList();
            foreach (var app in settings) Exec(d, $"UPDATE {table} SET app = NULL WHERE app = ?", app);

            var todo = All(d, $"SELECT DISTINCT program_name AS programName, host_name AS hostName, login_name AS loginName FROM {table} WHERE app IS NULL")
                .Select(c => new
                {
                    ProgramName = c["programName"] as string,
                    HostName = c["hostName"] as string,
                    LoginName = c["loginName"] as string,
                })
                .Select(c => new { c.ProgramName, c.HostName, c.LoginName, App = AppName(c.ProgramName, c.HostName, c.LoginName) })
                .Where(c => c.App != null)
                .ToList();
            if (todo.Count == 0) return;
            using var tx = d.BeginTransaction();
            using var set = Command(d, $"UPDATE {table} SET app = ? WHERE app IS NULL AND program_name IS ? AND host_name IS ? AND login_name IS ?", null, null, null, null);
            set.Transaction = tx;
            foreach (var c in todo)
            {
                Bind(set, c.App, c.ProgramName, c.HostName, c.LoginName);
                set.ExecuteNonQuery();
            }
            tx.Commit();
        }

        /// <summary>Opens (and on first use creates or upgrades) the SQLite file. Call inside lock(_sync).</summary>
        private SqliteConnection Open()
        {
            if (_handle != null) return _handle;
            var path = HistoryDbPath();
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var d = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ConnectionString);
            d.Open();
            try
            {
                Exec(d, @"
                    PRAGMA journal_mode = WAL;
                    PRAGMA synchronous = NORMAL;
                    CREATE TABLE IF NOT EXISTS sampled_activity (
                      id INTEGER PRIMARY KEY,
                      key TEXT NOT NULL UNIQUE,
                      server TEXT NOT NULL,
                      db TEXT,
                      session_id INTEGER,
                      request_start TEXT,
                      first_seen TEXT NOT NULL,
                      last_seen TEXT NOT NULL,
                      samples INTEGER NOT NULL DEFAULT 1,
                      action TEXT,
                      command TEXT,
                      proc_name TEXT,
                      statement TEXT,
                      tables TEXT,
                      login_name TEXT,
                      host_name TEXT,
                      client_address TEXT,
                      program_name TEXT,
                      job_name TEXT,
                      elapsed_ms INTEGER,
                      cpu_ms INTEGER,
                      logical_reads INTEGER,
                      writes INTEGER,
                      rows_affected INTEGER
                    );
                    CREATE INDEX IF NOT EXISTS ix_sampled_time ON sampled_activity (server, first_seen);
                    CREATE TABLE IF NOT EXISTS audit_event (
                      id INTEGER PRIMARY KEY,
                      dedupe BLOB NOT NULL UNIQUE,
                      server TEXT NOT NULL,
                      event_time TEXT NOT NULL,
                      action TEXT,
                      action_id TEXT,
                      succeeded INTEGER,
                      session_id INTEGER,
                      db TEXT,
                      schema_name TEXT,
                      object_name TEXT,
                      class_type TEXT,
                      login_name TEXT,
                      session_login TEXT,
                      db_user TEXT,
                      host_name TEXT,
                      client_ip TEXT,
                      program_name TEXT,
                      statement TEXT
                    );
                    CREATE INDEX IF NOT EXISTS ix_audit_time ON audit_event (server, event_time);
                    CREATE TABLE IF NOT EXISTS audit_state (
                      server TEXT PRIMARY KEY,
                      file_name TEXT,
                      file_offset TEXT
                    );");
                // Added after the first release: how the row was captured.
                var cols = All(d, "PRAGMA table_info(sampled_activity)");
                if (!cols.Any(c => (string?)c["name"] == "capture")) Exec(d, "ALTER TABLE sampled_activity ADD COLUMN capture TEXT NOT NULL DEFAULT 'running'");
                // Added later: the application each row came from.
                AddAppColumn(d, "sampled_activity");
                AddAppColumn(d, "audit_event");
            }
            catch
            {
                d.Dispose();
                throw;
            }
            _handle = d;
            return d;
        }

        /* ---------------- Writes ---------------- */

        /// <summary>Saves sampled rows; a row seen again updates its counters instead of adding a new one.</summary>
        public void SaveSamples(string server, IReadOnlyList<SampleRow> rows)
        {
            if (rows.Count == 0) return;
            lock (_sync)
            {
                var d = Open();
                using var tx = d.BeginTransaction();
                using var st = Command(
                    d,
                    @"INSERT INTO sampled_activity (key, server, db, session_id, request_start, first_seen, last_seen, action, command, proc_name, statement,
                        tables, login_name, host_name, client_address, program_name, job_name, elapsed_ms, cpu_ms, logical_reads, writes, rows_affected, capture, app)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                      ON CONFLICT (key) DO UPDATE SET last_seen = excluded.last_seen, samples = samples + 1, elapsed_ms = excluded.elapsed_ms,
                        cpu_ms = excluded.cpu_ms, logical_reads = excluded.logical_reads, writes = excluded.writes, rows_affected = excluded.rows_affected");
                st.Transaction = tx;
                foreach (var r in rows)
                {
                    Bind(
                        st,
                        r.Key, server, r.Db, r.SessionId, r.RequestStart, r.SeenAt, r.SeenAt, r.Action, r.Command, r.ProcName, r.Statement,
                        r.Tables, r.LoginName, r.HostName, r.ClientAddress, r.ProgramName, r.JobName, r.ElapsedMs, r.CpuMs, r.LogicalReads, r.Writes, r.RowsAffected, r.Capture,
                        AppName(r.ProgramName, r.HostName, r.LoginName));
                    st.ExecuteNonQuery();
                }
                tx.Commit();
            }
        }

        /// <summary>Returns how many of the rows were new (re-read records are ignored).</summary>
        public int SaveAuditEvents(string server, IReadOnlyList<AuditRow> rows)
        {
            if (rows.Count == 0) return 0;
            lock (_sync)
            {
                var d = Open();
                using var tx = d.BeginTransaction();
                using var st = Command(
                    d,
                    @"INSERT OR IGNORE INTO audit_event (dedupe, server, event_time, action, action_id, succeeded, session_id, db, schema_name, object_name,
                        class_type, login_name, session_login, db_user, host_name, client_ip, program_name, statement, app)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
                st.Transaction = tx;
                var added = 0;
                foreach (var r in rows)
                {
                    // Same fields, separator and hash as the records already in the file, so re-read records are recognised.
                    var identity = string.Join('\u0001', new[]
                    {
                        server, r.EventUtc, r.SessionId?.ToString(CultureInfo.InvariantCulture) ?? "", r.Sequence.ToString(CultureInfo.InvariantCulture), r.ActionId,
                        r.Db ?? "", r.SchemaName ?? "", r.ObjectName ?? "", r.ClassType ?? "", r.Statement ?? "",
                    });
                    var dedupe = SHA1.HashData(Encoding.UTF8.GetBytes(identity));
                    Bind(
                        st,
                        dedupe, server, r.EventTime, r.Action, r.ActionId, r.Succeeded ? 1 : 0, r.SessionId, r.Db, r.SchemaName, r.ObjectName,
                        r.ClassType, r.LoginName, r.SessionLogin, r.DbUser, r.HostName, r.ClientIp, r.ProgramName, r.Statement,
                        AppName(r.ProgramName, r.HostName, r.LoginName));
                    added += st.ExecuteNonQuery();
                }
                tx.Commit();
                return added;
            }
        }

        /// <summary>Where the audit reader got to (file + offset inside it), so each poll only reads new records.</summary>
        public (string? FileName, string? Offset) GetAuditPosition(string server)
        {
            lock (_sync)
            {
                var r = Get(Open(), "SELECT file_name AS fileName, file_offset AS offset FROM audit_state WHERE server = ?", server);
                return (r?["fileName"] as string, r?["offset"] is { } o ? Js.Str(o) : null);
            }
        }

        /// <summary>Remembers where the audit reader got to.</summary>
        public void SetAuditPosition(string server, string? fileName, string? offset)
        {
            lock (_sync)
            {
                Exec(
                    Open(),
                    @"INSERT INTO audit_state (server, file_name, file_offset) VALUES (?, ?, ?)
                      ON CONFLICT (server) DO UPDATE SET file_name = excluded.file_name, file_offset = excluded.file_offset",
                    server, fileName, offset);
            }
        }

        /// <summary>Delete rows older than the retention period.</summary>
        public (int Sampled, int Audit) PruneHistory()
        {
            var cutoff = Serialize.FormatDate(DateTime.UtcNow.AddDays(-_config.History.RetentionDays).ToLocalTime());
            lock (_sync)
            {
                var d = Open();
                var sampled = Exec(d, "DELETE FROM sampled_activity WHERE last_seen < ?", cutoff);
                var audit = Exec(d, "DELETE FROM audit_event WHERE event_time < ?", cutoff);
                return (sampled, audit);
            }
        }

        /* ---------------- Reads ---------------- */

        private static string Like(string v) => $"%{LikeSpecial.Replace(v, m => "\\" + m.Value)}%";

        private HistoryPage Page(string table, string timeCol, string[] searchCols, string[] whoCols, string select, HistoryFilter f)
        {
            var where = new List<string> { "server = ?" };
            var args = new List<object?> { f.Server };
            if (!string.IsNullOrEmpty(f.Capture) && table == "sampled_activity")
            {
                where.Add("capture = ?");
                args.Add(f.Capture);
            }
            if (!string.IsNullOrEmpty(f.Db))
            {
                where.Add("db = ? COLLATE NOCASE");
                args.Add(f.Db);
            }
            if (!string.IsNullOrEmpty(f.From))
            {
                where.Add($"{timeCol} >= ?");
                args.Add(Js.ReplaceFirst(f.From, "T", " "));
            }
            if (!string.IsNullOrEmpty(f.To))
            {
                where.Add($"{timeCol} <= ?");
                args.Add(Js.ReplaceFirst(f.To, "T", " "));
            }
            if (!string.IsNullOrEmpty(f.Action))
            {
                where.Add("action = ?");
                args.Add(f.Action);
            }
            if (!string.IsNullOrEmpty(f.Search))
            {
                where.Add($"({string.Join(" OR ", searchCols.Select(c => $@"{c} LIKE ? ESCAPE '\'"))})");
                foreach (var _ in searchCols) args.Add(Like(f.Search));
            }
            if (!string.IsNullOrEmpty(f.Who))
            {
                where.Add($"({string.Join(" OR ", whoCols.Select(c => $@"{c} LIKE ? ESCAPE '\'"))})");
                foreach (var _ in whoCols) args.Add(Like(f.Who));
            }
            if (!string.IsNullOrEmpty(f.WhoType)) where.Add(WhoTypes[f.WhoType]);
            if (!string.IsNullOrEmpty(f.Login))
            {
                where.Add("login_name = ? COLLATE NOCASE");
                args.Add(f.Login);
            }
            if (!string.IsNullOrEmpty(f.NotLogin))
            {
                where.Add("COALESCE(login_name, '') <> ? COLLATE NOCASE");
                args.Add(f.NotLogin);
            }
            if (!string.IsNullOrEmpty(f.App))
            {
                where.Add("app = ? COLLATE NOCASE");
                args.Add(f.App);
            }
            var whereSql = string.Join(" AND ", where);
            lock (_sync)
            {
                var d = Open();
                var total = Js.ToLong(Get(d, $"SELECT COUNT(*) AS n FROM {table} WHERE {whereSql}", args.ToArray())?["n"]);
                var rows = All(
                    d,
                    $"SELECT {select} FROM {table} WHERE {whereSql} ORDER BY {timeCol} DESC, id DESC LIMIT ? OFFSET ?",
                    args.Concat(new object?[] { f.PageSize, (long)(f.Page - 1) * f.PageSize }).ToArray());
                return new HistoryPage(rows, total, Math.Max(1, (long)Math.Ceiling(total / (double)f.PageSize)));
            }
        }

        /// <summary>A page of the sampled activity log, newest first.</summary>
        public HistoryPage QuerySampled(HistoryFilter f) => Page(
            "sampled_activity",
            "first_seen",
            new[] { "statement", "proc_name", "tables", "login_name", "host_name", "program_name", "job_name", "client_address" },
            new[] { "login_name", "host_name", "program_name", "job_name", "client_address" },
            @"id, db, session_id AS sessionId, request_start AS requestStart, first_seen AS firstSeen, last_seen AS lastSeen, samples, action, command,
              proc_name AS procName, statement, tables, login_name AS loginName, host_name AS hostName, client_address AS clientAddress,
              program_name AS programName, job_name AS jobName, elapsed_ms AS elapsedMs, cpu_ms AS cpuMs, logical_reads AS logicalReads,
              writes, rows_affected AS rowsAffected, capture, app",
            f);

        /// <summary>A page of the audit log, newest first.</summary>
        public HistoryPage QueryAudit(HistoryFilter f)
        {
            var r = Page(
                "audit_event",
                "event_time",
                new[] { "object_name", "statement", "login_name", "session_login", "db_user", "host_name", "client_ip", "program_name" },
                new[] { "login_name", "session_login", "db_user", "host_name", "client_ip", "program_name" },
                @"id, event_time AS eventTime, action, action_id AS actionId, succeeded, session_id AS sessionId, db, schema_name AS schemaName,
                  object_name AS objectName, class_type AS classType, login_name AS loginName, session_login AS sessionLogin, db_user AS dbUser,
                  host_name AS hostName, client_ip AS clientIp, program_name AS programName, statement, app",
                f);
            foreach (var x in r.Rows) x["succeeded"] = x["succeeded"] is long n && n == 1;
            return r;
        }

        private static string TableOf(string kind) => kind == "sampled" ? "sampled_activity" : "audit_event";

        /// <summary>The Windows domain logins seen in a log, busiest first, for the login dropdown.</summary>
        public List<object> DomainLogins(string kind, string server, string? dbName)
        {
            var args = new List<object?> { server };
            if (!string.IsNullOrEmpty(dbName)) args.Add(dbName);
            lock (_sync)
            {
                return All(
                        Open(),
                        $@"SELECT login_name AS login, COUNT(*) AS rows FROM {TableOf(kind)}
                           WHERE server = ? {(!string.IsNullOrEmpty(dbName) ? "AND db = ? COLLATE NOCASE" : "")} AND {IsUser}
                           GROUP BY login_name COLLATE NOCASE ORDER BY COUNT(*) DESC, login_name LIMIT 300",
                        args.ToArray())
                    .Select(r => (object)new { login = Js.Str(r["login"]), rows = Js.ToLong(r["rows"]) })
                    .ToList();
            }
        }

        /// <summary>The applications seen in a log, busiest first, for the app dropdown.</summary>
        public List<object> HistoryApps(string kind, string server, string? dbName)
        {
            var args = new List<object?> { server };
            if (!string.IsNullOrEmpty(dbName)) args.Add(dbName);
            lock (_sync)
            {
                return All(
                        Open(),
                        $@"SELECT app, COUNT(*) AS rows FROM {TableOf(kind)}
                           WHERE server = ? {(!string.IsNullOrEmpty(dbName) ? "AND db = ? COLLATE NOCASE" : "")} AND app IS NOT NULL
                           GROUP BY app COLLATE NOCASE ORDER BY COUNT(*) DESC, app LIMIT 300",
                        args.ToArray())
                    .Select(r => (object)new { app = Js.Str(r["app"]), rows = Js.ToLong(r["rows"]) })
                    .ToList();
            }
        }

        /// <summary>Row counts and oldest row per log, for the status line.</summary>
        public object HistoryTotals(string server)
        {
            lock (_sync)
            {
                var d = Open();
                var s = Get(d, "SELECT COUNT(*) AS n, MIN(first_seen) AS oldest FROM sampled_activity WHERE server = ?", server)!;
                var a = Get(d, "SELECT COUNT(*) AS n, MIN(event_time) AS oldest FROM audit_event WHERE server = ?", server)!;
                return new { sampledRows = Js.ToLong(s["n"]), sampledOldest = s["oldest"], auditRows = Js.ToLong(a["n"]), auditOldest = a["oldest"] };
            }
        }

        /// <inheritdoc />
        public void Dispose()
        {
            lock (_sync)
            {
                _handle?.Dispose();
                _handle = null;
            }
        }
    }
}
