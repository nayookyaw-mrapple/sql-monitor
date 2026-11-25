namespace API.Models
{
    /// <summary>A server + database SQL Monitor can monitor.</summary>
    /// <param name="Id">"server/database", lower-cased — used as the cache key and in the X-Target header.</param>
    /// <param name="Server">SQL Server name.</param>
    /// <param name="Database">Database name.</param>
    public sealed record Target(string Id, string Server, string Database)
    {
        /// <summary>Builds a target and its id.</summary>
        public static Target Make(string server, string database) => new($"{server}/{database}".ToLowerInvariant(), server, database);
    }

    /// <summary>A database offered in the Database selector.</summary>
    public sealed class TargetInfo
    {
        /// <summary>"server/database", lower-cased.</summary>
        public required string Id { get; init; }

        /// <summary>SQL Server name.</summary>
        public required string Server { get; init; }

        /// <summary>Database name.</summary>
        public required string Database { get; init; }

        /// <summary>Number of *HistoryT tables found in it.</summary>
        public int HistoryTables { get; init; }

        /// <summary>The database opened first.</summary>
        public bool IsDefault { get; set; }
    }

    /// <summary>Result of searching one SQL Server for databases.</summary>
    public sealed record ServerStatus(string Server, bool Ok, string? Error, int Databases);

    /// <summary>Site + Season the row-level security predicates filter on (SESSION_CONTEXT 'SiteID' / 'Season').</summary>
    public sealed record DataContext(int SiteId, int Season)
    {
        /// <summary>Cache key, "site:season".</summary>
        [System.Text.Json.Serialization.JsonIgnore]
        public string Key => $"{SiteId}:{Season}";
    }

    /// <summary>A site of the selected database.</summary>
    public sealed record Site(int SiteId, string SiteName, string? SiteType);

    /// <summary>A season of the selected database.</summary>
    public sealed record SeasonInfo(int Season, string? Description, bool IsCurrent, bool IsDefault);
}
