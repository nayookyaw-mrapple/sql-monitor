using API.Infrastructure;

namespace API.Configuration
{
    /// <summary>
    /// All settings of the server, read once at start from <c>server/.env</c> and environment variables.
    /// The names are the same as the ones the Node.js server used.
    /// </summary>
    public sealed class MonitorConfig
    {
        /// <summary>Reads and validates the settings; throws when a required one is missing.</summary>
        public MonitorConfig(IConfiguration c)
        {
            string? Get(string name) => c[name];
            string Required(string name)
            {
                var v = Get(name);
                if (string.IsNullOrEmpty(v)) throw new InvalidOperationException($"Missing required environment variable {name} (see server/.env.example)");
                return v;
            }
            int Int(string name, int fallback)
            {
                var v = Get(name);
                var n = string.IsNullOrEmpty(v) ? null : Js.ParseInt(v);
                return n is null ? fallback : (int)Math.Clamp(n.Value, int.MinValue, int.MaxValue);
            }
            static List<string> Distinct(IEnumerable<string> items) => items.Distinct().ToList();

            Port = Int("PORT", 3000);
            CorsOrigin = Get("CORS_ORIGIN") ?? "http://localhost:4200";

            var windows = (Get("DB_AUTH") ?? "sql").ToLowerInvariant() == "windows";
            Db = new DbSettings
            {
                Auth = windows ? "windows" : "sql",
                User = windows ? "" : Required("DB_USER"),
                Password = windows ? "" : Required("DB_PASSWORD"),
                Encrypt = (Get("DB_ENCRYPT") ?? "true") == "true",
                TrustServerCertificate = (Get("DB_TRUST_SERVER_CERTIFICATE") ?? "true") == "true",
                RequestTimeoutMs = Int("DB_REQUEST_TIMEOUT_MS", 300_000),
            };

            Servers = Distinct(
                (Get("DB_SERVERS") ?? "").Split(',').Append(Get("DB_SERVER") ?? "")
                    .Select(s => s.Trim())
                    .Where(s => s.Length > 0)
                    .Select(s => s.ToUpperInvariant()));
            if (Servers.Count == 0) throw new InvalidOperationException("Set DB_SERVERS in server/.env (comma-separated SQL Server names)");

            var legacy = !string.IsNullOrEmpty(Get("DB_SERVER")) && !string.IsNullOrEmpty(Get("DB_DATABASE")) ? $"{Get("DB_SERVER")}/{Get("DB_DATABASE")}" : "";
            Databases = Distinct(
                new[] { legacy }.Concat((Get("DB_DATABASES") ?? "").Split(','))
                    .Select(s => s.Trim().ToLowerInvariant())
                    .Where(s => s.Length > 0));

            TargetIdleMs = Int("TARGET_IDLE_MS", 60 * 60_000);
            DefaultSiteId = Int("DEFAULT_SITE_ID", 1);
            MsdbUser = !string.IsNullOrEmpty(Get("MSDB_USER")) ? Get("MSDB_USER")! : Get("DB_USER") ?? "";
            MsdbPassword = !string.IsNullOrEmpty(Get("MSDB_PASSWORD")) ? Get("MSDB_PASSWORD")! : Get("DB_PASSWORD") ?? "";
            TablePattern = Get("TABLE_PATTERN") ?? "%HistoryT";
            ActivityPollMs = Int("ACTIVITY_POLL_MS", 15_000);
            CatalogRefreshMs = Int("CATALOG_REFRESH_MS", 10 * 60_000);
            LastChangeScanMaxRows = Int("LAST_CHANGE_SCAN_MAX_ROWS", 1_000_000);
            LastChangeRefreshMs = Int("LAST_CHANGE_REFRESH_MS", 15 * 60_000);
            LargeTableRows = Int("LARGE_TABLE_ROWS", 1_000_000);
            ReadUncommitted = (Get("READ_UNCOMMITTED") ?? "true") == "true";

            History = new HistorySettings
            {
                Servers = Distinct((Get("HISTORY_SERVERS") ?? "").Split(',').Select(s => s.Trim().ToUpperInvariant()).Where(s => s.Length > 0)),
                DbPath = string.IsNullOrEmpty(Get("HISTORY_DB_PATH")) ? "data/history.db" : Get("HISTORY_DB_PATH")!,
                SampleMs = Math.Max(1000, Int("HISTORY_SAMPLE_MS", 5000)),
                AuditPollMs = Math.Max(5000, Int("HISTORY_AUDIT_POLL_MS", 30_000)),
                RetentionDays = Math.Max(1, Int("HISTORY_RETENTION_DAYS", 30)),
                AuditName = string.IsNullOrEmpty(Get("HISTORY_AUDIT_NAME")) ? "SQL_Monitor_Audit" : Get("HISTORY_AUDIT_NAME")!,
                AuditFilePattern = Get("HISTORY_AUDIT_FILE_PATTERN") ?? "",
            };
        }

        /// <summary>HTTP port.</summary>
        public int Port { get; }

        /// <summary>Allowed browser origins (comma-separated).</summary>
        public string CorsOrigin { get; }

        /// <summary>How to connect to SQL Server.</summary>
        public DbSettings Db { get; }

        /// <summary>
        /// SQL Servers to search for databases (upper-cased). Every database on them that the login can open
        /// and that has *HistoryT tables can be offered in the Database selector. (DB_SERVER is still accepted.)
        /// </summary>
        public List<string> Servers { get; }

        /// <summary>
        /// Databases shown in the Database selector, in order (lower-cased). Each entry is a database name or
        /// "server/database". The FIRST one found is the default. Empty = every database with History tables.
        /// </summary>
        public List<string> Databases { get; }

        /// <summary>Monitoring of a database stops after this long without anyone viewing it.</summary>
        public int TargetIdleMs { get; }

        /// <summary>Site used when the client sends no X-Site-Id header.</summary>
        public int DefaultSiteId { get; }

        /// <summary>Optional separate login for SQL Agent job history in msdb; otherwise the main login.</summary>
        public string MsdbUser { get; }

        /// <summary>Password of <see cref="MsdbUser"/>.</summary>
        public string MsdbPassword { get; }

        /// <summary>Only tables whose name matches this LIKE pattern are exposed.</summary>
        public string TablePattern { get; }

        /// <summary>How often row counts are polled to detect new history rows (cheap metadata query).</summary>
        public int ActivityPollMs { get; }

        /// <summary>How often the catalog (tables/columns) is reloaded.</summary>
        public int CatalogRefreshMs { get; }

        /// <summary>Tables at or below this row count get their "last change" time computed in the background.</summary>
        public int LastChangeScanMaxRows { get; }

        /// <summary>Full refresh interval for the background "last change" scan.</summary>
        public int LastChangeRefreshMs { get; }

        /// <summary>Tables at or above this row count are flagged as "large" in the UI.</summary>
        public int LargeTableRows { get; }

        /// <summary>Read with READ UNCOMMITTED so long monitoring scans never block application writes.</summary>
        public bool ReadUncommitted { get; }

        /// <summary>Activity history (local SQLite file).</summary>
        public HistorySettings History { get; }
    }

    /// <summary>SQL Server connection settings.</summary>
    public sealed class DbSettings
    {
        /// <summary>
        /// "windows" = Windows Authentication as the account running the server; "sql" = SQL login with DB_USER / DB_PASSWORD.
        /// </summary>
        public required string Auth { get; init; }

        /// <summary>SQL login name (empty with Windows Authentication).</summary>
        public required string User { get; init; }

        /// <summary>SQL login password.</summary>
        public required string Password { get; init; }

        /// <summary>Encrypt the connection.</summary>
        public bool Encrypt { get; init; }

        /// <summary>Accept the server's certificate without checking it.</summary>
        public bool TrustServerCertificate { get; init; }

        /// <summary>Timeout for data queries. Large unindexed History tables can take minutes to sort.</summary>
        public int RequestTimeoutMs { get; init; }
    }

    /// <summary>
    /// Activity history: who ran what, kept in a local SQLite file. Runs all the time for the servers listed in
    /// HISTORY_SERVERS (each must also be in DB_SERVERS); empty = off. Nothing is written to SQL Server.
    /// </summary>
    public sealed class HistorySettings
    {
        /// <summary>Servers to record (upper-cased).</summary>
        public required List<string> Servers { get; init; }

        /// <summary>SQLite file; a relative path is resolved from the server/ folder.</summary>
        public required string DbPath { get; init; }

        /// <summary>How often "Running now" is sampled.</summary>
        public int SampleMs { get; init; }

        /// <summary>How often new SQL Server Audit records are copied in.</summary>
        public int AuditPollMs { get; init; }

        /// <summary>Rows older than this are deleted from the SQLite file.</summary>
        public int RetentionDays { get; init; }

        /// <summary>Name of the SQL Server Audit a DBA created for SQL Monitor.</summary>
        public required string AuditName { get; init; }

        /// <summary>Optional audit file pattern when it can't be looked up.</summary>
        public required string AuditFilePattern { get; init; }
    }
}
