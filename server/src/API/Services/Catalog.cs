using System.Text.RegularExpressions;
using API.Configuration;
using API.Infrastructure;

namespace API.Services
{
    /// <summary>A column of a history table.</summary>
    public sealed record ColumnInfo(string Name, string Type, int MaxLength, bool Nullable, bool IsIdentity);

    /// <summary>A history table SQL Monitor can show.</summary>
    public sealed class TableInfo
    {
        /// <summary>Schema name.</summary>
        public required string Schema { get; init; }

        /// <summary>Table name.</summary>
        public required string Name { get; init; }

        /// <summary>schema.name — the identifier used by the API.</summary>
        public required string FullName { get; init; }

        /// <summary>Module prefix, e.g. "cs", "ma", "sw".</summary>
        public required string Module { get; init; }

        /// <summary>Name without module prefix and trailing "HistoryT", e.g. "FDC_Status".</summary>
        public required string DisplayName { get; init; }

        /// <summary>Columns in table order.</summary>
        public required List<ColumnInfo> Columns { get; init; }

        /// <summary>Primary key columns in key order.</summary>
        public required List<string> PrimaryKey { get; init; }

        /// <summary>Column used for "latest first" ordering.</summary>
        public required string SortColumn { get; init; }

        /// <summary>True when the table has the standard HistoryDateTime / RecordAction audit columns.</summary>
        public bool HasAuditColumns { get; init; }

        /// <summary>RecordAction, when the table has it.</summary>
        public string? ActionColumn { get; init; }

        /// <summary>HistoryUserName or HistoryBy, when the table has one.</summary>
        public string? UserColumn { get; init; }

        /// <summary>Physical row count from partition metadata (all sites/seasons).</summary>
        public long RowCount { get; set; }

        /// <summary>Row-level security filter applied to this table: none, site, season, season_site or other.</summary>
        public required string Rls { get; init; }
    }

    /// <summary>The history tables of each database (one catalog per target).</summary>
    public sealed class Catalog
    {
        /// <summary>Column types that hold a date.</summary>
        public static readonly HashSet<string> DateTypes = new() { "datetime", "datetime2", "smalldatetime", "date", "datetimeoffset" };

        private static readonly string[] PreferredSort = { "HistoryDateTime", "HistoryDate", "ModifiedDateTime", "DateModified", "CreatedDateTime", "CreateDateTime", "CreateDate" };
        private static readonly Regex HistorySuffix = new("_?HistoryT$", RegexOptions.IgnoreCase | RegexOptions.Compiled);
        private static readonly Regex RlsSeasonSite = new("Season_and_Site", RegexOptions.IgnoreCase | RegexOptions.Compiled);
        private static readonly Regex RlsSeason = new(@"Predicate_Season\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);
        private static readonly Regex RlsSite = new(@"Predicate_Site\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);

        private readonly MonitorConfig _config;
        private readonly Db _db;
        private readonly TargetRegistry _targets;
        private readonly ILogger<Catalog> _logger;

        /// <summary>Creates the catalog.</summary>
        public Catalog(MonitorConfig config, Db db, TargetRegistry targets, ILogger<Catalog> logger)
        {
            _config = config;
            _db = db;
            _targets = targets;
            _logger = logger;
        }

        private sealed class State
        {
            public volatile Dictionary<string, TableInfo> Tables = new();
            public DateTime? LoadedAtUtc;
        }

        private State Cat() => _targets.State("catalog", () => new State());

        private static string PickSortColumn(List<ColumnInfo> columns, List<string> primaryKey)
        {
            var byName = new Dictionary<string, ColumnInfo>();
            foreach (var c in columns) byName[c.Name.ToLowerInvariant()] = c;
            foreach (var p in PreferredSort)
            {
                if (byName.TryGetValue(p.ToLowerInvariant(), out var c) && DateTypes.Contains(c.Type)) return c.Name;
            }
            var identity = columns.FirstOrDefault(c => c.IsIdentity);
            if (identity != null) return identity.Name;
            var anyDate = columns.FirstOrDefault(c => DateTypes.Contains(c.Type));
            if (anyDate != null) return anyDate.Name;
            return primaryKey.Count > 0 ? primaryKey[0] : columns[0].Name;
        }

        private static (string Module, string DisplayName) SplitName(string name)
        {
            var idx = name.IndexOf('_');
            var module = idx > 0 ? name.Substring(0, idx) : "other";
            var rest = idx > 0 ? name.Substring(idx + 1) : name;
            var trimmed = HistorySuffix.Replace(rest, "", 1);
            if (trimmed.Length > 0) rest = trimmed;
            return (module, rest);
        }

        /// <summary>Loads the tables, columns, primary keys, row counts and row-level security of the current database.</summary>
        public async Task LoadCatalogAsync()
        {
            QueryOptions Opts() => new() { Params = new[] { P.NVarChar("pattern", 256, _config.TablePattern) } };

            var tablesTask = _db.ReadQueryAsync(
                @"SELECT SCHEMA_NAME(t.schema_id) AS schemaName, t.name AS tableName
                  FROM sys.tables t WHERE t.is_ms_shipped = 0 AND t.name LIKE @pattern", Opts());
            var columnsTask = _db.ReadQueryAsync(
                @"SELECT SCHEMA_NAME(t.schema_id) AS schemaName, t.name AS tableName, c.name AS columnName,
                         TYPE_NAME(c.system_type_id) AS typeName, c.max_length AS maxLength,
                         c.is_nullable AS isNullable, c.is_identity AS isIdentity
                  FROM sys.tables t JOIN sys.columns c ON c.object_id = t.object_id
                  WHERE t.is_ms_shipped = 0 AND t.name LIKE @pattern
                  ORDER BY t.object_id, c.column_id", Opts());
            var pkTask = _db.ReadQueryAsync(
                @"SELECT SCHEMA_NAME(t.schema_id) AS schemaName, t.name AS tableName, c.name AS columnName
                  FROM sys.tables t
                  JOIN sys.indexes i ON i.object_id = t.object_id AND i.is_primary_key = 1
                  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                  WHERE t.is_ms_shipped = 0 AND t.name LIKE @pattern
                  ORDER BY t.object_id, ic.key_ordinal", Opts());
            var countsTask = FetchRowCountsAsync();
            var rlsTask = _db.ReadQueryAsync(
                @"SELECT SCHEMA_NAME(t.schema_id) AS schemaName, t.name AS tableName, pr.predicate_definition AS predicate
                  FROM sys.security_predicates pr
                  JOIN sys.security_policies sp ON sp.object_id = pr.object_id AND sp.is_enabled = 1
                  JOIN sys.tables t ON t.object_id = pr.target_object_id
                  WHERE pr.predicate_type = 0 AND t.name LIKE @pattern", Opts());
            await Task.WhenAll(tablesTask, columnsTask, pkTask, countsTask, rlsTask);

            static string Key(Row r) => $"{r["schemaName"]}.{r["tableName"]}";

            var rlsBy = new Dictionary<string, string>();
            foreach (var r in rlsTask.Result)
            {
                var p = Js.Text(r["predicate"]) ?? "";
                rlsBy[Key(r)] = RlsSeasonSite.IsMatch(p) ? "season_site" : RlsSeason.IsMatch(p) ? "season" : RlsSite.IsMatch(p) ? "site" : "other";
            }

            var colsBy = new Dictionary<string, List<ColumnInfo>>();
            foreach (var r in columnsTask.Result)
            {
                var k = Key(r);
                if (!colsBy.TryGetValue(k, out var list)) colsBy[k] = list = new List<ColumnInfo>();
                list.Add(new ColumnInfo(
                    (string)r["columnName"]!,
                    Js.Text(r["typeName"]) ?? "",
                    (int)Js.ToLong(r["maxLength"]),
                    Js.Truthy(r["isNullable"]),
                    Js.Truthy(r["isIdentity"])));
            }
            var pkBy = new Dictionary<string, List<string>>();
            foreach (var r in pkTask.Result)
            {
                var k = Key(r);
                if (!pkBy.TryGetValue(k, out var list)) pkBy[k] = list = new List<string>();
                list.Add((string)r["columnName"]!);
            }

            var counts = countsTask.Result;
            var next = new Dictionary<string, TableInfo>();
            foreach (var t in tablesTask.Result)
            {
                var fullName = Key(t);
                if (!colsBy.TryGetValue(fullName, out var columns) || columns.Count == 0) continue;
                var primaryKey = pkBy.TryGetValue(fullName, out var pk) ? pk : new List<string>();
                var names = new HashSet<string>(columns.Select(c => c.Name));
                var tableName = (string)t["tableName"]!;
                var (module, displayName) = SplitName(tableName);
                next[fullName.ToLowerInvariant()] = new TableInfo
                {
                    Schema = (string)t["schemaName"]!,
                    Name = tableName,
                    FullName = fullName,
                    Module = module,
                    DisplayName = displayName,
                    Columns = columns,
                    PrimaryKey = primaryKey,
                    SortColumn = PickSortColumn(columns, primaryKey),
                    HasAuditColumns = names.Contains("HistoryDateTime") && names.Contains("RecordAction"),
                    ActionColumn = names.Contains("RecordAction") ? "RecordAction" : null,
                    UserColumn = names.Contains("HistoryUserName") ? "HistoryUserName" : names.Contains("HistoryBy") ? "HistoryBy" : null,
                    RowCount = counts.TryGetValue(fullName.ToLowerInvariant(), out var n) ? n : 0,
                    Rls = rlsBy.TryGetValue(fullName, out var rls) ? rls : "none",
                };
            }
            var c = Cat();
            c.Tables = next;
            c.LoadedAtUtc = DateTime.UtcNow;
            var target = _targets.Current;
            _logger.LogInformation("[catalog] {Server}/{Database}: loaded {Count} tables matching '{Pattern}'", target.Server, target.Database, next.Count, _config.TablePattern);
        }

        /// <summary>Row counts from partition metadata — instant, no table scan. Keyed by lower-case schema.name.</summary>
        public async Task<Dictionary<string, long>> FetchRowCountsAsync()
        {
            var rows = await _db.ReadQueryAsync(
                @"SELECT SCHEMA_NAME(t.schema_id) + '.' + t.name AS fullName, SUM(p.row_count) AS totalRows
                  FROM sys.tables t
                  JOIN sys.dm_db_partition_stats p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
                  WHERE t.is_ms_shipped = 0 AND t.name LIKE @pattern
                  GROUP BY t.schema_id, t.name",
                new QueryOptions { Params = new[] { P.NVarChar("pattern", 256, _config.TablePattern) } });
            var result = new Dictionary<string, long>();
            foreach (var r in rows) result[((string)r["fullName"]!).ToLowerInvariant()] = Js.ToLong(r["totalRows"]);
            return result;
        }

        /// <summary>All tables of the current database.</summary>
        public List<TableInfo> GetTables() => Cat().Tables.Values.ToList();

        /// <summary>A table by "schema.name" (or just the name, in dbo), case-insensitive.</summary>
        public TableInfo? GetTable(string fullName)
        {
            var key = fullName.Contains('.') ? fullName : $"dbo.{fullName}";
            return Cat().Tables.TryGetValue(key.ToLowerInvariant(), out var t) ? t : null;
        }

        /// <summary>When the catalog was last loaded (UTC), or null.</summary>
        public DateTime? LoadedAtUtc => Cat().LoadedAtUtc;

        /// <summary>[schema].[name], safely quoted.</summary>
        public static string Qualified(TableInfo t) => $"{Db.Q(t.Schema)}.{Db.Q(t.Name)}";
    }
}
