using API.Configuration;
using API.Infrastructure;
using API.Services;
using Microsoft.AspNetCore.Mvc;

namespace API.Controllers
{
    /// <summary>SQL Server Agent jobs of the selected database's server.</summary>
    [ApiController]
    [Route("api/jobs")]
    [Produces("application/json")]
    public class JobsController : ControllerBase
    {
        private readonly MonitorConfig _config;
        private readonly Db _db;
        private readonly AgentJobService _jobs;

        /// <summary>Creates the controller.</summary>
        public JobsController(MonitorConfig config, Db db, AgentJobService jobs)
        {
            _config = config;
            _db = db;
            _jobs = jobs;
        }

        /// <summary>Every job with its last outcome, plus the script that gives the login access to msdb.</summary>
        [HttpGetOrHead("")]
        public async Task<IActionResult> List()
        {
            var result = await _jobs.JobsAsync(Request.Raw("refresh") == "1", HttpContext.RequestAborted);
            var grantTo = _config.Db.Auth == "windows" ? await _db.DbLoginAsync() : _config.MsdbUser;
            return Ok(new { result, grantScript = ErrorService.AgentGrantScript(grantTo) });
        }

        /// <summary>The steps of one job and its recent runs.</summary>
        [HttpGetOrHead("{jobId}")]
        public async Task<IActionResult> Detail(string jobId)
        {
            if (!Guid.TryParse(jobId, out var id)) throw new HttpError(400, "Invalid job id");
            return Ok(await _jobs.JobDetailAsync(id, HttpContext.RequestAborted));
        }
    }
}
