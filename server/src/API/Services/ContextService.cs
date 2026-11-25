using API.Configuration;
using API.Infrastructure;
using API.Models;

namespace API.Services
{
    /// <summary>Sites and seasons of each database, and the Site/Season a request asks for.</summary>
    public sealed class ContextService
    {
        private readonly MonitorConfig _config;
        private readonly Db _db;
        private readonly TargetRegistry _targets;
        private readonly Catalog _catalog;
        private readonly ILogger<ContextService> _logger;

        /// <summary>Creates the service.</summary>
        public ContextService(MonitorConfig config, Db db, TargetRegistry targets, Catalog catalog, ILogger<ContextService> logger)
        {
            _config = config;
            _db = db;
            _targets = targets;
            _catalog = catalog;
            _logger = logger;
        }

        /// <summary>Sites and seasons of the current database (one per target).</summary>
        private sealed class Options
        {
            public volatile List<Site> Sites = new();
            public volatile List<SeasonInfo> Seasons = new();
        }

        private Options Opts() => _targets.State("context", () => new Options());

        /// <summary>Lower-cased column names of a table — site databases can be on older schemas.</summary>
        private async Task<HashSet<string>> ColumnsOfAsync(string table)
        {
            var rows = await _db.ReadQueryAsync($"SELECT c.name FROM sys.columns c WHERE c.object_id = OBJECT_ID('{table}')");
            return new HashSet<string>(rows.Select(r => ((string)r["name"]!).ToLowerInvariant()));
        }

        /// <summary>Loads the site and season lists of the current database.</summary>
        public async Task LoadContextOptionsAsync()
        {
            var o = Opts();
            try
            {
                var siteCols = await ColumnsOfAsync("dbo.sw_Environment_Site_DBT");
                if (siteCols.Contains("siteid"))
                {
                    // Only the id/name/type columns — this table also holds integration credentials.
                    var rows = await _db.ReadQueryAsync(
                        $@"SELECT SiteID, {(siteCols.Contains("sitename") ? "SiteName" : "CAST(NULL AS varchar(1))")} AS SiteName,
                                  {(siteCols.Contains("sitetype") ? "SiteType" : "CAST(NULL AS varchar(1))")} AS SiteType
                           FROM dbo.sw_Environment_Site_DBT ORDER BY SiteID");
                    o.Sites = rows.Select(r =>
                    {
                        var id = (int)Js.ToLong(r["SiteID"]);
                        return new Site(id, Js.Text(r["SiteName"]) ?? $"Site {id}", Js.Text(r["SiteType"]));
                    }).ToList();
                }
                else
                {
                    o.Sites = new List<Site>();
                }
            }
            catch (Exception err)
            {
                _logger.LogWarning("[context] sites unavailable: {Message}", err.Message);
                o.Sites = new List<Site>();
            }
            try
            {
                var c = await ColumnsOfAsync("dbo.sw_SeasonT");
                if (!c.Contains("season"))
                {
                    o.Seasons = new List<SeasonInfo>();
                }
                else
                {
                    string Col(string name, string fallback) => c.Contains(name.ToLowerInvariant()) ? name : fallback;
                    var where = c.Contains("availableforsessioncontextflag") ? "WHERE AvailableForSessionContextFlag = 1" : "";
                    var rows = await _db.ReadQueryAsync(
                        $@"SELECT Season, {Col("SeasonDesc", "CAST(NULL AS varchar(1))")} AS SeasonDesc,
                                  {Col("CurrentSeason", "CAST(0 AS bit)")} AS CurrentSeason,
                                  {Col("DefaultSeasonFlag", "CAST(0 AS bit)")} AS DefaultSeasonFlag
                           FROM dbo.sw_SeasonT {where} ORDER BY Season DESC");
                    o.Seasons = rows.Select(r => new SeasonInfo(
                        (int)Js.ToLong(r["Season"]),
                        Js.Text(r["SeasonDesc"]),
                        Js.Truthy(r["CurrentSeason"]),
                        Js.Truthy(r["DefaultSeasonFlag"]))).ToList();
                }
            }
            catch (Exception err)
            {
                _logger.LogWarning("[context] seasons unavailable: {Message}", err.Message);
                o.Seasons = new List<SeasonInfo>();
            }
            var t = _targets.Current;
            _logger.LogInformation("[context] {Server}/{Database}: {Sites} sites, {Seasons} seasons", t.Server, t.Database, o.Sites.Count, o.Seasons.Count);
        }

        /// <summary>The Site/Season used when the request does not choose one.</summary>
        public DataContext DefaultContext()
        {
            var o = Opts();
            var sites = o.Sites;
            var seasons = o.Seasons;
            var siteId = sites.Any(s => s.SiteId == _config.DefaultSiteId) ? _config.DefaultSiteId : sites.Count > 0 ? sites[0].SiteId : 1;
            var season = (seasons.FirstOrDefault(s => s.IsDefault) ?? seasons.FirstOrDefault(s => s.IsCurrent) ?? seasons.FirstOrDefault())?.Season ?? DateTime.Now.Year;
            return new DataContext(siteId, season);
        }

        /// <summary>Sites, seasons and defaults for the header selectors.</summary>
        public object ContextOptions()
        {
            var o = Opts();
            var rlsTables = _catalog.GetTables().Count(t => t.Rls != "none");
            return new { sites = o.Sites, seasons = o.Seasons, defaults = DefaultContext(), rlsTables };
        }

        /// <summary>
        /// Site/Season from the X-Site-Id / X-Season headers (or ?siteId= / ?season=). Values that don't exist in
        /// the selected database (e.g. right after switching databases) fall back to that database's defaults.
        /// </summary>
        public DataContext From(HttpRequest req)
        {
            var def = DefaultContext();
            var o = Opts();
            var rawSite = HeaderOrQuery(req, "x-site-id", "siteId");
            var rawSeason = HeaderOrQuery(req, "x-season", "season");
            var siteId = string.IsNullOrEmpty(rawSite) ? null : Js.ParseInt(rawSite);
            var season = string.IsNullOrEmpty(rawSeason) ? null : Js.ParseInt(rawSeason);
            return new DataContext(
                siteId is not null && o.Sites.Any(s => s.SiteId == siteId) ? (int)siteId.Value : def.SiteId,
                season is not null && o.Seasons.Any(s => s.Season == season) ? (int)season.Value : def.Season);
        }

        private static string? HeaderOrQuery(HttpRequest req, string header, string query)
        {
            if (req.Headers.TryGetValue(header, out var h)) return h.ToString();
            return req.Query.TryGetValue(query, out var q) && q.Count == 1 ? q.ToString() : null;
        }
    }
}
