using API.Configuration;
using API.Infrastructure;
using API.Models;

namespace API.Services
{
    /// <summary>Finds the databases that can be offered in the Database selector.</summary>
    public sealed class Discovery
    {
        private readonly MonitorConfig _config;
        private readonly Db _db;
        private readonly TargetRegistry _targets;
        private readonly ILogger<Discovery> _logger;
        private readonly TaskCompletionSource _firstRun = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private volatile IReadOnlyList<ServerStatus> _serverStatus = Array.Empty<ServerStatus>();

        /// <summary>Creates the service.</summary>
        public Discovery(MonitorConfig config, Db db, TargetRegistry targets, ILogger<Discovery> logger)
        {
            _config = config;
            _db = db;
            _targets = targets;
            _logger = logger;
        }

        /// <summary>Completes when the databases have been searched for the first time; API requests wait for it.</summary>
        public Task Ready => _firstRun.Task;

        /// <summary>SQL string literal for a database name (names come from sys.databases, but quote them anyway).</summary>
        private static string Lit(string v) => $"N'{v.Replace("'", "''")}'";

        /// <summary>Databases on one server that this login can open and that contain *HistoryT tables.</summary>
        private async Task<List<TargetInfo>> DiscoverServerAsync(string server)
        {
            var dbs = await _db.ReadQueryAsync(
                @"SELECT name FROM sys.databases
                  WHERE database_id > 4 AND state = 0 AND HAS_DBACCESS(name) = 1 AND source_database_id IS NULL
                  ORDER BY name",
                new QueryOptions { Pool = PoolName.Master, Server = server });
            if (dbs.Count == 0) return new List<TargetInfo>();
            var pattern = _config.TablePattern.Replace("'", "''");
            var union = string.Join(" UNION ALL ", dbs.Select(d =>
            {
                var name = (string)d["name"]!;
                return $"SELECT {Lit(name)} AS name, (SELECT COUNT(*) FROM {Db.Q(name)}.sys.tables WHERE name LIKE N'{pattern}') AS n";
            }));
            var rows = await _db.ReadQueryAsync(
                $"SELECT name, n FROM ({union}) x WHERE n > 0 ORDER BY name",
                new QueryOptions { Pool = PoolName.Master, Server = server });
            return rows.Select(r =>
            {
                var t = Target.Make(server, (string)r["name"]!);
                return new TargetInfo { Id = t.Id, Server = t.Server, Database = t.Database, HistoryTables = (int)Js.ToLong(r["n"]), IsDefault = false };
            }).ToList();
        }

        /// <summary>Searches every server in DB_SERVERS and publishes the list of databases and the default one.</summary>
        public async Task DiscoverTargetsAsync()
        {
            try
            {
                var results = await Task.WhenAll(_config.Servers.Select(async server =>
                {
                    try
                    {
                        var found = await DiscoverServerAsync(server);
                        return (Found: found, Status: new ServerStatus(server, true, null, found.Count));
                    }
                    catch (Exception err)
                    {
                        _logger.LogError("[discovery] {Server}: {Message}", server, err.Message);
                        return (Found: new List<TargetInfo>(), Status: new ServerStatus(server, false, err.Message, 0));
                    }
                }));

                // Keep only the databases in DB_DATABASES (by name, or server/name), in DB_SERVERS order.
                var allowed = _config.Databases;
                int ServerRank(TargetInfo t) => _config.Servers.IndexOf(t.Server.ToUpperInvariant());
                var all = results.SelectMany(r => r.Found)
                    .OrderBy(ServerRank)
                    .ThenBy(t => t.Database, Js.TextOrder)
                    .ToList();
                static bool Matches(TargetInfo t, string entry) => t.Id == entry || t.Database.ToLowerInvariant() == entry;
                var visible = allowed.Count > 0 ? all.Where(t => allowed.Any(e => Matches(t, e))).ToList() : all;

                // Default = the first DB_DATABASES entry that exists (or the first database found when the list is empty).
                var def = allowed.Count > 0
                    ? allowed.Select(e => visible.FirstOrDefault(t => Matches(t, e))).FirstOrDefault(t => t != null)
                    : visible.FirstOrDefault();
                foreach (var t in visible) t.IsDefault = t.Id == def?.Id;
                _targets.SetDefault(def != null ? Target.Make(def.Server, def.Database) : null);

                visible = visible.OrderBy(t => t.Server, Js.TextOrder).ThenBy(t => t.Database, Js.TextOrder).ToList();
                _targets.SetKnown(visible);
                foreach (var name in allowed)
                {
                    if (!visible.Any(t => t.Database.ToLowerInvariant() == name || t.Id == name))
                        _logger.LogWarning("[discovery] DB_DATABASES entry '{Name}' not found on {Servers}", name, string.Join(", ", _config.Servers));
                }
                _serverStatus = results.Select(r => r.Status).OrderBy(s => s.Server, Js.TextOrder).ToList();
                _logger.LogInformation(
                    "[discovery] showing {Visible} of {All} databases on {Servers}; default {Default}",
                    visible.Count, all.Count, string.Join(", ", _config.Servers), def != null ? $"{def.Server}/{def.Database}" : "none");
            }
            finally
            {
                _firstRun.TrySetResult();
            }
        }

        /// <summary>Per server: whether it could be searched, and how many databases it gave.</summary>
        public IReadOnlyList<ServerStatus> Status => _serverStatus;
    }
}
