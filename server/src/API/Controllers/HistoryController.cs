using API.Configuration;
using API.Infrastructure;
using API.Services;
using Microsoft.AspNetCore.Mvc;

namespace API.Controllers
{
    /// <summary>Activity history (local SQLite: sampled activity + SQL Server Audit records).</summary>
    [ApiController]
    [Route("api/history")]
    [Produces("application/json")]
    public class HistoryController : ControllerBase
    {
        private static readonly string[] HistoryActions = { "INSERT", "UPDATE", "DELETE", "MERGE", "SELECT", "EXECUTE", "TRUNCATE", "DDL", "OTHER" };
        private static readonly string[] WhoTypes = { "agent", "user", "maui", "other" };

        /// <summary>Most rows one export can hold. The total in the response says how many matched, so the client can tell when it was cut.</summary>
        private const int ExportMaxRows = 20_000;

        private readonly MonitorConfig _config;
        private readonly Db _db;
        private readonly TargetRegistry _targets;
        private readonly HistoryStore _store;
        private readonly Sampler _sampler;
        private readonly AuditReader _audit;

        /// <summary>Creates the controller.</summary>
        public HistoryController(MonitorConfig config, Db db, TargetRegistry targets, HistoryStore store, Sampler sampler, AuditReader audit)
        {
            _config = config;
            _db = db;
            _targets = targets;
            _store = store;
            _sampler = sampler;
            _audit = audit;
        }

        private string? ScopeDb() => Request.Scope() == "server" ? null : _targets.Current.Database;

        private HistoryFilter Filter(int? page = null, int? pageSize = null)
        {
            var (from, to) = Request.DateRange();
            var action = Request.Str("action")?.ToUpperInvariant();
            if (action != null && !HistoryActions.Contains(action)) throw new HttpError(400, "Invalid action");
            var whoType = Request.Str("whoType");
            if (whoType != null && !WhoTypes.Contains(whoType)) throw new HttpError(400, "Invalid whoType");
            var capture = Request.Str("capture");
            if (capture != null && capture != "running" && capture != "last") throw new HttpError(400, "Invalid capture");
            return new HistoryFilter
            {
                Server = _targets.Current.Server,
                Db = ScopeDb(),
                From = from != null ? Serialize.IsoParam(from) : null,
                To = to != null ? Serialize.IsoParam(to, true) : null,
                Action = action,
                Search = Request.Str("search"),
                Who = Request.Str("who"),
                WhoType = whoType,
                Login = Request.Str("login"),
                NotLogin = Request.Str("notLogin"),
                App = Request.Str("app"),
                Capture = capture,
                Page = page ?? Request.Page(),
                PageSize = pageSize ?? Request.PageSize(),
            };
        }

        private static string Kind(string kind) =>
            kind is "sampled" or "audit" ? kind : throw new HttpError(404, "Unknown history log");

        /// <summary>State of the sampler and the audit reader, totals, and the audit setup script.</summary>
        [HttpGetOrHead("status")]
        public async Task<IActionResult> Status()
        {
            var t = _targets.Current;
            return Ok(new
            {
                server = t.Server,
                retentionDays = _config.History.RetentionDays,
                sampler = _sampler.Status(t.Server),
                audit = _audit.Status(t.Server),
                totals = _store.HistoryTotals(t.Server),
                auditSetupScript = _audit.AuditSetupScript(t.Database, await _db.DbLoginAsync()),
            });
        }

        /// <summary>A page of the sampled activity log.</summary>
        [HttpGetOrHead("sampled")]
        public IActionResult Sampled()
        {
            var f = Filter();
            var r = _store.QuerySampled(f);
            return Ok(new { rows = r.Rows, total = r.Total, totalPages = r.TotalPages, page = f.Page, pageSize = f.PageSize });
        }

        /// <summary>A page of the audit log.</summary>
        [HttpGetOrHead("audit")]
        public IActionResult Audit()
        {
            var f = Filter();
            var r = _store.QueryAudit(f);
            return Ok(new { rows = r.Rows, total = r.Total, totalPages = r.TotalPages, page = f.Page, pageSize = f.PageSize });
        }

        /// <summary>Every row matching the filter (newest first, not just one page), for the Excel / PDF export.</summary>
        [HttpGetOrHead("sampled/export")]
        public IActionResult SampledExport()
        {
            var r = _store.QuerySampled(Filter(1, ExportMaxRows));
            return Ok(new { rows = r.Rows, total = r.Total, limit = ExportMaxRows });
        }

        /// <summary>Every audit record matching the filter, for the Excel / PDF export.</summary>
        [HttpGetOrHead("audit/export")]
        public IActionResult AuditExport()
        {
            var r = _store.QueryAudit(Filter(1, ExportMaxRows));
            return Ok(new { rows = r.Rows, total = r.Total, limit = ExportMaxRows });
        }

        /// <summary>Domain logins seen in the log (for the login dropdown), busiest first.</summary>
        [HttpGetOrHead("{kind}/logins")]
        public IActionResult Logins(string kind) =>
            Ok(new { logins = _store.DomainLogins(Kind(kind), _targets.Current.Server, ScopeDb()) });

        /// <summary>Applications seen in the log (for the app dropdown), busiest first.</summary>
        [HttpGetOrHead("{kind}/apps")]
        public IActionResult Apps(string kind) =>
            Ok(new { apps = _store.HistoryApps(Kind(kind), _targets.Current.Server, ScopeDb()) });
    }
}
