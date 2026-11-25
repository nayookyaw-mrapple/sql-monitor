using System.Diagnostics;
using API.Infrastructure;
using API.Services;
using Microsoft.AspNetCore.Mvc;

namespace API.Controllers
{
    /// <summary>Live activity (row-count changes) and the latest changes across all tables.</summary>
    [ApiController]
    [Route("api")]
    [Produces("application/json")]
    public class ActivityController : ControllerBase
    {
        private readonly ContextService _context;
        private readonly MonitorService _monitor;

        /// <summary>Creates the controller.</summary>
        public ActivityController(ContextService context, MonitorService monitor)
        {
            _context = context;
            _monitor = monitor;
        }

        /// <summary>Row-count changes detected by the poll, newest first.</summary>
        [HttpGetOrHead("activity")]
        public IActionResult Activity()
        {
            var limit = (int)Math.Min(1000, Math.Max(1, Request.Int("limit", 200)));
            var sinceId = Request.Int("sinceId", 0);
            return Ok(new { monitor = _monitor.Status(), events = _monitor.GetEvents(limit, sinceId) });
        }

        /// <summary>Newest history rows across all tables, all time (from the cache) or inside a date range.</summary>
        [HttpGetOrHead("latest-changes")]
        public async Task<IActionResult> LatestChanges()
        {
            var ctx = _context.From(Request);
            var limit = (int)Math.Min(1000, Math.Max(1, Request.Int("limit", 100)));
            var module = Request.Str("module");
            var (from, to) = Request.DateRange();
            static string? Cut(string? v) => v is null ? null : Js.Left(v, 200);
            var filter = new LatestFilter(Cut(Request.Str("action")), Cut(Request.Str("user")), Cut(Request.Str("table")));
            var timer = Stopwatch.StartNew();
            if (from is null && to is null)
            {
                // All time: newest 5 rows of every table, straight from the background cache.
                return Ok(new
                {
                    context = ctx,
                    monitor = _monitor.Status(ctx),
                    rows = _monitor.GetLatestChanges(ctx, limit, module, filter),
                    scannedTables = (int?)null,
                    perTable = 5,
                    elapsedMs = 0L,
                });
            }
            var r = await _monitor.GetLatestChangesInRangeAsync(ctx, limit, module, from, to, HttpContext.RequestAborted, filter);
            return Ok(new
            {
                context = ctx,
                monitor = _monitor.Status(ctx),
                rows = r.Rows,
                scannedTables = (int?)r.ScannedTables,
                perTable = MonitorService.LatestPerTable(filter),
                elapsedMs = timer.ElapsedMilliseconds,
            });
        }
    }
}
