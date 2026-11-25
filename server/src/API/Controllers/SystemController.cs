using System.Diagnostics;
using API.Configuration;
using API.Infrastructure;
using API.Services;
using Microsoft.AspNetCore.Mvc;

namespace API.Controllers
{
    /// <summary>Health, the database and Site/Season selectors, and the dashboard summary.</summary>
    [ApiController]
    [Route("api")]
    [Produces("application/json")]
    public class SystemController : ControllerBase
    {
        private readonly MonitorConfig _config;
        private readonly Db _db;
        private readonly TargetRegistry _targets;
        private readonly Catalog _catalog;
        private readonly ContextService _context;
        private readonly MonitorService _monitor;
        private readonly Discovery _discovery;
        private readonly TableSummaries _summaries;

        /// <summary>Creates the controller.</summary>
        public SystemController(MonitorConfig config, Db db, TargetRegistry targets, Catalog catalog, ContextService context, MonitorService monitor, Discovery discovery, TableSummaries summaries)
        {
            _config = config;
            _db = db;
            _targets = targets;
            _catalog = catalog;
            _context = context;
            _monitor = monitor;
            _discovery = discovery;
            _summaries = summaries;
        }

        /// <summary>Checks that the selected database answers.</summary>
        [HttpGetOrHead("health")]
        public async Task<IActionResult> Health()
        {
            var timer = Stopwatch.StartNew();
            await _db.ReadQueryAsync("SELECT 1 AS ok");
            var t = _targets.Current;
            return Ok(new { ok = true, database = t.Database, server = t.Server, dbLatencyMs = timer.ElapsedMilliseconds });
        }

        /// <summary>Sites and seasons for the header selectors.</summary>
        [HttpGetOrHead("context")]
        public IActionResult Context() => Ok(_context.ContextOptions());

        /// <summary>Databases offered in the header's Database selector.</summary>
        [HttpGetOrHead("targets")]
        public IActionResult Targets() =>
            Ok(new { targets = _targets.Known, servers = _discovery.Status, @default = _targets.Default.Id, active = _monitor.ActiveTargets() });

        /// <summary>Totals, modules and recently changed tables for the dashboard.</summary>
        [HttpGetOrHead("summary")]
        public async Task<IActionResult> Summary()
        {
            var ctx = _context.From(Request);
            var tables = _catalog.GetTables();
            var modules = tables
                .GroupBy(t => t.Module)
                .Select(g => new { module = g.Key, tables = g.Count(), rows = g.Sum(t => t.RowCount) })
                .OrderBy(m => m.module, Js.TextOrder)
                .ToList();
            var recent = tables
                .Select(t => _summaries.Of(t, ctx))
                .Where(t => !string.IsNullOrEmpty(t.LastChange))
                .OrderByDescending(t => t.LastChange ?? "", Js.TextOrder)
                .Take(15)
                .ToList();
            var target = _targets.Current;
            return Ok(new
            {
                database = target.Database,
                server = target.Server,
                target = target.Id,
                auth = _config.Db.Auth,
                login = await _db.DbLoginAsync(),
                context = ctx,
                tablePattern = _config.TablePattern,
                catalogLoadedAt = _catalog.LoadedAtUtc is { } loaded ? Serialize.IsoUtc(loaded) : null,
                tableCount = tables.Count,
                rlsTableCount = tables.Count(t => t.Rls != "none"),
                totalRows = tables.Sum(t => t.RowCount),
                largeTableCount = tables.Count(t => t.RowCount >= _config.LargeTableRows),
                modules,
                recentlyChangedTables = recent,
                monitor = _monitor.Status(ctx),
            });
        }
    }
}
