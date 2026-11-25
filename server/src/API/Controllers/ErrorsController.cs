using System.Diagnostics;
using API.Configuration;
using API.Infrastructure;
using API.Services;
using Microsoft.AspNetCore.Mvc;

namespace API.Controllers
{
    /// <summary>Errors and failures from every error source.</summary>
    [ApiController]
    [Route("api/errors")]
    [Produces("application/json")]
    public class ErrorsController : ControllerBase
    {
        private static readonly string[] Severities = { "error", "warning", "info" };

        private readonly MonitorConfig _config;
        private readonly Db _db;
        private readonly ContextService _context;
        private readonly ErrorService _errors;

        /// <summary>Creates the controller.</summary>
        public ErrorsController(MonitorConfig config, Db db, ContextService context, ErrorService errors)
        {
            _config = config;
            _db = db;
            _context = context;
            _errors = errors;
        }

        private string? SourceParam()
        {
            var source = Request.Str("source");
            if (source != null && ErrorService.GetSource(source) is null) throw new HttpError(400, $"Unknown error source '{source}'");
            return source;
        }

        /// <summary>The error sources of the selected database with their counts.</summary>
        [HttpGetOrHead("sources")]
        public async Task<IActionResult> Sources()
        {
            var ctx = _context.From(Request);
            var sources = await _errors.SourceStatusesAsync(ctx, Request.Raw("refresh") == "1");
            var grantTo = _config.Db.Auth == "windows" ? await _db.DbLoginAsync() : _config.MsdbUser;
            return Ok(new { context = ctx, sources, agentGrantScript = ErrorService.AgentGrantScript(grantTo) });
        }

        /// <summary>One page of errors, from one source or all sources merged by time.</summary>
        [HttpGetOrHead("")]
        public async Task<IActionResult> List()
        {
            var ctx = _context.From(Request);
            var source = SourceParam();
            var page = Request.Page();
            var pageSize = Request.PageSize();
            // The merged view fetches (offset + size) rows from every source, so cap how deep it can page.
            if (source is null && (long)page * pageSize > 10_000) throw new HttpError(400, "Choose a single source or narrow the date range to page this far back");
            var (from, to) = Request.DateRange();
            var severity = Request.Str("severity");
            if (severity != null && !Severities.Contains(severity)) throw new HttpError(400, "Invalid severity");

            var timer = Stopwatch.StartNew();
            var result = await _errors.QueryErrorsAsync(source, new ErrorFilters(from, to, Request.Str("search"), severity), ctx, page, pageSize, HttpContext.RequestAborted);
            return Ok(new
            {
                page = result.Page,
                pageSize = result.PageSize,
                total = result.Total,
                totalPages = result.TotalPages,
                rows = result.Rows,
                skipped = result.Skipped,
                context = ctx,
                elapsedMs = timer.ElapsedMilliseconds,
            });
        }

        /// <summary>The most frequent error messages in the range.</summary>
        [HttpGetOrHead("recurring")]
        public async Task<IActionResult> Recurring()
        {
            var ctx = _context.From(Request);
            var source = SourceParam();
            var (from, to) = Request.DateRange();
            return Ok(new { rows = await _errors.RecurringErrorsAsync(source, from, to, ctx, HttpContext.RequestAborted) });
        }
    }
}
