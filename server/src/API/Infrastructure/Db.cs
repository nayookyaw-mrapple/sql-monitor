using System.Collections.Concurrent;
using System.Data;
using System.Text.RegularExpressions;
using API.Configuration;
using API.Models;
using API.Services;
using Microsoft.Data.SqlClient;

namespace API.Infrastructure
{
    /// <summary>main = the selected database; msdb = SQL Agent job history; master = database discovery.</summary>
    public enum PoolName
    {
        /// <summary>The selected database.</summary>
        Main,

        /// <summary>msdb on the same server (SQL Agent job history).</summary>
        Msdb,

        /// <summary>master on the same server (discovery, server-wide views).</summary>
        Master,
    }

    /// <summary>A bound query parameter.</summary>
    public sealed record SqlParam(string Name, SqlDbType Type, int Size, object? Value);

    /// <summary>Shorthand for building parameters.</summary>
    public static class P
    {
        /// <summary>varchar(size) parameter.</summary>
        public static SqlParam VarChar(string name, int size, object? value) => new(name, SqlDbType.VarChar, size, value);

        /// <summary>nvarchar(size) parameter.</summary>
        public static SqlParam NVarChar(string name, int size, object? value) => new(name, SqlDbType.NVarChar, size, value);

        /// <summary>int parameter.</summary>
        public static SqlParam Int(string name, object? value) => new(name, SqlDbType.Int, 0, value);

        /// <summary>bigint parameter.</summary>
        public static SqlParam BigInt(string name, object? value) => new(name, SqlDbType.BigInt, 0, value);

        /// <summary>bit parameter.</summary>
        public static SqlParam Bit(string name, bool value) => new(name, SqlDbType.Bit, 0, value);
    }

    /// <summary>How one read query is run.</summary>
    public sealed class QueryOptions
    {
        /// <summary>Bound parameters.</summary>
        public IReadOnlyList<SqlParam>? Params { get; init; }

        /// <summary>Cancellation; the SQL request is cancelled on the server when it fires.</summary>
        public CancellationToken Signal { get; init; }

        /// <summary>Use READ UNCOMMITTED for this statement (avoid blocking writers on long scans).</summary>
        public bool Dirty { get; init; }

        /// <summary>Site/Season for row-level security.</summary>
        public DataContext? Context { get; init; }

        /// <summary>Which database to use (default: the selected database).</summary>
        public PoolName Pool { get; init; } = PoolName.Main;

        /// <summary>Server for msdb/master (default: the selected database's server).</summary>
        public string? Server { get; init; }
    }

    /// <summary>
    /// Read-only access to SQL Server. One connection pool per server + database (ADO.NET pools by connection
    /// string), created on first use.
    /// </summary>
    public sealed class Db
    {
        /// <summary>Application name of the monitor's own connections (the sampler leaves these out).</summary>
        public const string AppName = "SQL Monitor (read-only)";

        /// <summary>
        /// Words that must never appear in SQL issued by this service. Every statement is built
        /// from fixed templates in this codebase, so this is a last line of defence that keeps the
        /// backend strictly read-only even though the DB login itself has write rights.
        /// </summary>
        private static readonly Regex Forbidden = new(
            @"\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE|GRANT|REVOKE|DENY|BACKUP|RESTORE|DBCC|SHUTDOWN|KILL|OPENROWSET|OPENQUERY|OPENDATASOURCE|BULK|INTO)\b",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);

        private static readonly Regex Bracketed = new(@"\[[^\]]*\]", RegexOptions.Compiled);
        private static readonly Regex StringLiteral = new(@"'(?:[^']|'')*'", RegexOptions.Compiled);
        private static readonly Regex StartsWithSelect = new(@"^\s*(SELECT|WITH)\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);

        /// <summary>
        /// Fixed preamble prepended to every batch. Both keys are always (re)set — to NULL when no
        /// context is given — so a pooled connection can never carry another request's Site/Season.
        /// </summary>
        private const string ContextPreamble =
            "EXEC sys.sp_set_session_context @key = N'SiteID', @value = @__ctxSiteId; " +
            "EXEC sys.sp_set_session_context @key = N'Season', @value = @__ctxSeason; ";

        private readonly MonitorConfig _config;
        private readonly TargetRegistry _targets;
        private readonly ConcurrentDictionary<string, string> _connectionStrings = new();

        /// <summary>Creates the database access.</summary>
        public Db(MonitorConfig config, TargetRegistry targets)
        {
            _config = config;
            _targets = targets;
        }

        /// <summary>Throws unless the text is a single SELECT statement without any write/DDL/EXEC keyword.</summary>
        public static void AssertReadOnly(string text)
        {
            // Strip bracketed identifiers and string literals before checking keywords.
            var stripped = StringLiteral.Replace(Bracketed.Replace(text, "[]"), "''");
            if (!StartsWithSelect.IsMatch(stripped) || stripped.Contains(';') || Forbidden.IsMatch(stripped))
                throw new InvalidOperationException("Refused to run a non read-only statement");
        }

        /// <summary>Equivalent of T-SQL QUOTENAME for identifiers that come from the catalog.</summary>
        public static string Q(string identifier) => $"[{identifier.Replace("]", "]]")}]";

        private string ConnectionString(PoolName pool, string? server)
        {
            var srv = server ?? _targets.Current.Server;
            var database = pool switch
            {
                PoolName.Main => _targets.Current.Database,
                PoolName.Msdb => "msdb",
                _ => "master",
            };
            return _connectionStrings.GetOrAdd($"{srv}|{database}".ToLowerInvariant(), _ =>
            {
                var b = new SqlConnectionStringBuilder
                {
                    DataSource = srv,
                    InitialCatalog = database,
                    Encrypt = _config.Db.Encrypt,
                    TrustServerCertificate = _config.Db.TrustServerCertificate,
                    ApplicationIntent = ApplicationIntent.ReadOnly,
                    ApplicationName = AppName,
                    ConnectTimeout = 30,
                    MaxPoolSize = 10,
                    MinPoolSize = 0,
                    Pooling = true,
                };
                if (_config.Db.Auth == "windows")
                {
                    // Windows Authentication: connects as the Windows account running this process.
                    b.IntegratedSecurity = true;
                }
                else
                {
                    b.UserID = pool == PoolName.Msdb ? _config.MsdbUser : _config.Db.User;
                    b.Password = pool == PoolName.Msdb ? _config.MsdbPassword : _config.Db.Password;
                }
                return b.ConnectionString;
            });
        }

        /// <summary>Runs one SELECT and returns its rows. Refuses anything that is not read-only.</summary>
        public async Task<List<Row>> ReadQueryAsync(string text, QueryOptions? opts = null)
        {
            opts ??= new QueryOptions();
            AssertReadOnly(text);
            var signal = opts.Signal;
            var connectionString = ConnectionString(opts.Pool, opts.Server);
            var isolation = opts.Dirty && _config.ReadUncommitted ? "SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; " : "";

            if (signal.IsCancellationRequested) throw new CancelledError();
            try
            {
                await using var connection = new SqlConnection(connectionString);
                await connection.OpenAsync(signal);
                await using var command = connection.CreateCommand();
                command.CommandText = ContextPreamble + isolation + text;
                command.CommandTimeout = _config.Db.RequestTimeoutMs <= 0 ? 0 : Math.Max(1, (int)Math.Ceiling(_config.Db.RequestTimeoutMs / 1000.0));

                foreach (var p in opts.Params ?? Array.Empty<SqlParam>())
                {
                    var sp = p.Size > 0 ? new SqlParameter("@" + p.Name, p.Type, p.Size) : new SqlParameter("@" + p.Name, p.Type);
                    sp.Value = p.Value ?? DBNull.Value;
                    command.Parameters.Add(sp);
                }
                command.Parameters.Add(new SqlParameter("@__ctxSiteId", SqlDbType.Int) { Value = (object?)opts.Context?.SiteId ?? DBNull.Value });
                command.Parameters.Add(new SqlParameter("@__ctxSeason", SqlDbType.Int) { Value = (object?)opts.Context?.Season ?? DBNull.Value });

                var rows = new List<Row>();
                await using var reader = await command.ExecuteReaderAsync(signal);
                var count = reader.FieldCount;
                var names = new string[count];
                var asBytes = new bool[count];
                for (var i = 0; i < count; i++)
                {
                    names[i] = reader.GetName(i);
                    // CLR types (geography, geometry, hierarchyid) need an extra assembly to read as objects: take the raw bytes.
                    var type = reader.GetDataTypeName(i);
                    asBytes[i] = type.EndsWith("geography", StringComparison.OrdinalIgnoreCase)
                        || type.EndsWith("geometry", StringComparison.OrdinalIgnoreCase)
                        || type.EndsWith("hierarchyid", StringComparison.OrdinalIgnoreCase);
                }
                while (await reader.ReadAsync(signal))
                {
                    var row = new Row(count);
                    for (var i = 0; i < count; i++)
                    {
                        row[names[i]] = reader.IsDBNull(i) ? null : asBytes[i] ? reader.GetSqlBytes(i).Value : reader.GetValue(i);
                    }
                    rows.Add(row);
                }
                return rows;
            }
            catch (Exception) when (signal.IsCancellationRequested)
            {
                throw new CancelledError();
            }
        }

        /// <summary>The login SQL Monitor is connected as: the SQL login, or DOMAIN\user with Windows Authentication.</summary>
        public async Task<string> DbLoginAsync()
        {
            var s = _targets.State("login", () => new LoginHolder());
            if (string.IsNullOrEmpty(s.Name))
            {
                var rows = await ReadQueryAsync("SELECT SUSER_SNAME() AS l");
                s.Name = Js.Text(rows.FirstOrDefault()?["l"]) ?? "?";
            }
            return s.Name;
        }

        private sealed class LoginHolder
        {
            public volatile string? Name;
        }
    }
}
