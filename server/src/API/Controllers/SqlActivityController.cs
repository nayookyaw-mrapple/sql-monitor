using API.Infrastructure;
using API.Services;
using Microsoft.AspNetCore.Mvc;

namespace API.Controllers
{
    /// <summary>SQL activity: running requests, locks, deadlocks and procedure stats.</summary>
    [ApiController]
    [Route("api/sql")]
    [Produces("application/json")]
    public class SqlActivityController : ControllerBase
    {
        private readonly SqlActivityService _activity;

        /// <summary>Creates the controller.</summary>
        public SqlActivityController(SqlActivityService activity) => _activity = activity;

        /// <summary>What is running now, blockers and open transactions.</summary>
        [HttpGetOrHead("live")]
        public async Task<IActionResult> Live() =>
            Ok(await _activity.LiveActivityAsync(Request.Scope(), Request.Raw("background") == "1", HttpContext.RequestAborted));

        /// <summary>Locks held and waited for.</summary>
        [HttpGetOrHead("locks")]
        public async Task<IActionResult> Locks() =>
            Ok(new { rows = await _activity.LockSummaryAsync(Request.Scope(), HttpContext.RequestAborted) });

        /// <summary>Deadlocks recorded by SQL Server.</summary>
        [HttpGetOrHead("deadlocks")]
        public async Task<IActionResult> Deadlocks() =>
            Ok(await _activity.DeadlocksAsync(Request.Scope(), Request.Raw("refresh") == "1", HttpContext.RequestAborted));

        /// <summary>Execution statistics per procedure.</summary>
        [HttpGetOrHead("procedures")]
        public async Task<IActionResult> Procedures()
        {
            var sort = Request.Str("sort") ?? "total";
            if (!SqlActivityService.ProcSortKeys.Contains(sort)) throw new HttpError(400, "Invalid sort");
            return Ok(new { rows = await _activity.ProcedureStatsAsync(Request.Scope(), sort, HttpContext.RequestAborted) });
        }
    }
}
