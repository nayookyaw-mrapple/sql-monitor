using System.Collections.Concurrent;
using API.Infrastructure;

namespace API.Services
{
    /// <summary>
    /// SQL Server Agent jobs of the selected database's server: every job with its last outcome, and the run
    /// history of one job. Read from msdb (sysjobs, sysjobhistory, sysjobsteps); nothing is changed and no job
    /// is ever started or stopped. Category, "running now" and next run come from syscategories and
    /// sysjobactivity when the login can read them.
    /// </summary>
    public sealed class AgentJobService
    {
        /// <summary>sysjobhistory.run_duration (HHMMSS as a number) in seconds.</summary>
        private const string Seconds = "(h.run_duration / 10000 * 3600 + h.run_duration / 100 % 100 * 60 + h.run_duration % 100)";

        private const string History = "msdb.dbo.sysjobhistory h";

        private readonly Db _db;
        private readonly TargetRegistry _targets;
        private readonly ConcurrentDictionary<string, (long At, object Data)> _cache = new();

        /// <summary>Creates the service.</summary>
        public AgentJobService(Db db, TargetRegistry targets)
        {
            _db = db;
            _targets = targets;
        }

        /// <summary>sysjobhistory.run_status as a word.</summary>
        private static string StatusName(object? runStatus) => runStatus is null ? "never" : Js.ToLong(runStatus) switch
        {
            0 => "failed",
            1 => "succeeded",
            2 => "retry",
            3 => "cancelled",
            _ => "running",
        };

        private static string? Trimmed(object? value) => (value as string)?.Trim();

        /// <summary>Every job on the current server with its last outcome (cached 10 s per server).</summary>
        public async Task<object> JobsAsync(bool force, CancellationToken signal)
        {
            var server = _targets.Current.Server;
            if (!force && _cache.TryGetValue(server, out var cached) && Js.NowMs() - cached.At < 10_000) return cached.Data;

            List<Row> rows;
            List<Row> stepRows;
            try
            {
                // What each job runs: the command of every step (first 8000 characters is plenty to read names from).
                var stepsTask = _db.ReadQueryAsync(
                    @"SELECT CONVERT(varchar(36), s.job_id) AS jobId, s.step_id AS stepId, s.subsystem, LEFT(s.command, 8000) AS command,
                             s.output_file_name AS outputFile
                      FROM msdb.dbo.sysjobsteps s ORDER BY s.job_id, s.step_id",
                    new QueryOptions { Pool = PoolName.Msdb, Dirty = true, Signal = signal });
                var jobsTask = _db.ReadQueryAsync(
                    $@"SELECT CONVERT(varchar(36), j.job_id) AS jobId, j.name, j.enabled, j.description, j.date_modified AS modifiedAt,
                              SUSER_SNAME(j.owner_sid) AS owner,
                              (SELECT COUNT(*) FROM msdb.dbo.sysjobsteps s WHERE s.job_id = j.job_id) AS steps,
                              l.run_status AS lastStatus, l.at AS lastRunAt, l.seconds AS lastSeconds, l.message AS lastMessage,
                              e.step_id AS failedStepId, e.step_name AS failedStepName, e.message AS failedMessage,
                              f.at AS lastFailedAt, x.runs7d, x.failed7d
                       FROM msdb.dbo.sysjobs j
                       OUTER APPLY (SELECT TOP (1) h.instance_id, h.run_date, h.run_time, h.run_status, {ErrorSource.AgentTime} AS at, {Seconds} AS seconds, h.message
                                    FROM {History} WHERE h.job_id = j.job_id AND h.step_id = 0 ORDER BY h.instance_id DESC) l
                       OUTER APPLY (SELECT TOP (1) h.step_id, h.step_name, h.message
                                    FROM {History}
                                    WHERE h.job_id = j.job_id AND h.step_id > 0 AND h.run_status = 0 AND l.run_status = 0 AND h.instance_id < l.instance_id
                                      AND (h.run_date > l.run_date OR (h.run_date = l.run_date AND h.run_time >= l.run_time))
                                    ORDER BY h.instance_id DESC) e
                       OUTER APPLY (SELECT TOP (1) {ErrorSource.AgentTime} AS at
                                    FROM {History} WHERE h.job_id = j.job_id AND h.step_id = 0 AND h.run_status = 0 ORDER BY h.instance_id DESC) f
                       OUTER APPLY (SELECT COUNT(*) AS runs7d, SUM(CASE WHEN h.run_status = 0 THEN 1 ELSE 0 END) AS failed7d
                                    FROM {History}
                                    WHERE h.job_id = j.job_id AND h.step_id = 0
                                      AND h.run_date >= CONVERT(int, CONVERT(char(8), DATEADD(DAY, -7, GETDATE()), 112))) x
                       ORDER BY j.name",
                    new QueryOptions { Pool = PoolName.Msdb, Dirty = true, Signal = signal });
                await Task.WhenAll(jobsTask, stepsTask);
                rows = jobsTask.Result;
                stepRows = stepsTask.Result;
            }
            catch (Exception err) when (err is not CancelledError)
            {
                return new { server, available = false, reason = err.Message, extras = false, jobs = Array.Empty<object>() };
            }

            // Optional: needs SELECT on two more msdb tables. Without it the list still works, minus these columns.
            var extras = new Dictionary<string, Row>();
            var hasExtras = false;
            try
            {
                var more = await _db.ReadQueryAsync(
                    @"SELECT CONVERT(varchar(36), j.job_id) AS jobId, c.name AS category,
                             CASE WHEN a.start_execution_date IS NOT NULL AND a.stop_execution_date IS NULL THEN a.start_execution_date END AS runningSince,
                             a.next_scheduled_run_date AS nextRunAt
                      FROM msdb.dbo.sysjobs j
                      LEFT JOIN msdb.dbo.syscategories c ON c.category_id = j.category_id
                      LEFT JOIN msdb.dbo.sysjobactivity a ON a.job_id = j.job_id
                           AND a.session_id = (SELECT MAX(session_id) FROM msdb.dbo.sysjobactivity)",
                    new QueryOptions { Pool = PoolName.Msdb, Dirty = true, Signal = signal });
                foreach (var m in more) extras[(string)m["jobId"]!] = m;
                hasExtras = true;
            }
            catch (Exception err) when (err is not CancelledError)
            {
                /* no access to sysjobactivity / syscategories */
            }

            var stepsByJob = stepRows.ToLookup(r => (string)r["jobId"]!);

            var jobs = rows.Select(r =>
            {
                var id = (string)r["jobId"]!;
                var jobSteps = stepsByJob[id].ToList();
                var commands = jobSteps.Select(s => s["command"] as string).Where(c => !string.IsNullOrWhiteSpace(c)).ToList();
                var files = jobSteps.SelectMany(s => JobCommand.Files(s["command"] as string))
                    .Concat(jobSteps.Select(s => Trimmed(s["outputFile"])).Where(f => !string.IsNullOrEmpty(f)).Select(f => f!))
                    .Distinct(StringComparer.OrdinalIgnoreCase).ToList();
                extras.TryGetValue(id, out var x);
                var enabled = Js.Truthy(r["enabled"]);
                var runningSince = Serialize.Value(x?["runningSince"]);
                var description = Trimmed(r["description"]);
                return (object)new
                {
                    jobId = id,
                    name = r["name"],
                    enabled,
                    description = string.IsNullOrEmpty(description) || description == "No description available." ? null : description,
                    category = x?["category"],
                    owner = r["owner"],
                    steps = Js.ToLong(r["steps"]),
                    kinds = jobSteps.Select(s => JobCommand.Kind(s["subsystem"] as string)).Distinct().ToList(),
                    procs = jobSteps.SelectMany(s => JobCommand.Procedures(s["subsystem"] as string, s["command"] as string))
                        .Distinct(StringComparer.OrdinalIgnoreCase).ToList(),
                    files,
                    preview = JobCommand.Preview(commands.FirstOrDefault(), 200),
                    // Not shown: lets the search box find a job by anything in its commands.
                    commandText = JobCommand.Preview(string.Join(" | ", commands), 3000),
                    status = runningSince != null ? "running" : StatusName(r["lastStatus"]),
                    lastRunAt = Serialize.Value(r["lastRunAt"]),
                    lastSeconds = Js.ToNullableLong(r["lastSeconds"]),
                    lastMessage = Trimmed(r["lastMessage"]),
                    failedStep = r["failedStepId"] is null ? null : $"{r["failedStepId"]} · {r["failedStepName"]}",
                    failedMessage = Trimmed(r["failedMessage"]),
                    lastFailedAt = Serialize.Value(r["lastFailedAt"]),
                    runs7d = Js.ToLong(r["runs7d"]),
                    failed7d = Js.ToLong(r["failed7d"]),
                    runningSince,
                    nextRunAt = enabled ? Serialize.Value(x?["nextRunAt"]) : null,
                    modifiedAt = Serialize.Value(r["modifiedAt"]),
                };
            }).ToList();

            object data = new { server, available = true, reason = (string?)null, extras = hasExtras, jobs };
            _cache[server] = (Js.NowMs(), data);
            return data;
        }

        /// <summary>The steps of one job and its most recent runs, each with the outcome of every step.</summary>
        public async Task<object> JobDetailAsync(Guid jobId, CancellationToken signal)
        {
            SqlParam[] Params() => new[] { P.VarChar("id", 36, jobId.ToString()) };
            var stepsTask = _db.ReadQueryAsync(
                @"SELECT s.step_id AS stepId, s.step_name AS name, s.subsystem, s.database_name AS db, LEFT(s.command, 30000) AS command,
                         s.output_file_name AS outputFile
                  FROM msdb.dbo.sysjobsteps s WHERE s.job_id = CONVERT(uniqueidentifier, @id) ORDER BY s.step_id",
                new QueryOptions { Pool = PoolName.Msdb, Dirty = true, Signal = signal, Params = Params() });
            var historyTask = _db.ReadQueryAsync(
                $@"SELECT TOP (400) h.step_id AS stepId, h.step_name AS stepName, h.run_status AS runStatus, {ErrorSource.AgentTime} AS at, {Seconds} AS seconds,
                          h.message, h.sql_message_id AS sqlMessageId, h.sql_severity AS sqlSeverity, h.retries_attempted AS retries
                   FROM {History} WHERE h.job_id = CONVERT(uniqueidentifier, @id) ORDER BY h.instance_id DESC",
                new QueryOptions { Pool = PoolName.Msdb, Dirty = true, Signal = signal, Params = Params() });
            await Task.WhenAll(stepsTask, historyTask);

            // Newest first: a job outcome row (step 0) is followed by the steps of that run. Steps seen before
            // any outcome row belong to a run that has not finished yet.
            var runs = new List<JobRun>();
            JobRun? run = null;
            foreach (var h in historyTask.Result)
            {
                var stepId = Js.ToLong(h["stepId"]);
                var at = Js.Text(Serialize.Value(h["at"]));
                var seconds = Js.ToLong(h["seconds"]);
                var message = Trimmed(h["message"]);
                if (stepId == 0)
                {
                    run = new JobRun { Status = StatusName(h["runStatus"]), At = at, Seconds = seconds, Message = message };
                    runs.Add(run);
                    continue;
                }
                if (run is null)
                {
                    run = new JobRun { Status = "running", At = at, Seconds = null, Message = null };
                    runs.Add(run);
                }
                if (run.Status == "running") run.At = at;
                run.Steps.Insert(0, new JobRunStep
                {
                    StepId = stepId,
                    StepName = h["stepName"] as string,
                    Status = StatusName(h["runStatus"]),
                    At = at,
                    Seconds = seconds,
                    Message = message,
                    SqlMessageId = Js.ToLong(h["sqlMessageId"]),
                    SqlSeverity = Js.ToLong(h["sqlSeverity"]),
                    Retries = Js.ToLong(h["retries"]),
                });
            }

            var steps = stepsTask.Result.Select(s => new
            {
                stepId = Js.ToLong(s["stepId"]),
                name = s["name"],
                subsystem = s["subsystem"],
                kind = JobCommand.Kind(s["subsystem"] as string),
                db = s["db"],
                command = s["command"],
                outputFile = Trimmed(s["outputFile"]) is { Length: > 0 } f ? f : null,
                procs = JobCommand.Procedures(s["subsystem"] as string, s["command"] as string),
                files = JobCommand.Files(s["command"] as string),
            }).ToList();
            return new { steps, runs };
        }

        /// <summary>One execution of a job.</summary>
        public sealed class JobRun
        {
            /// <summary>failed, succeeded, retry, cancelled or running.</summary>
            public required string Status { get; init; }

            /// <summary>When the run started.</summary>
            public string? At { get; set; }

            /// <summary>How long it took.</summary>
            public long? Seconds { get; init; }

            /// <summary>The job outcome message.</summary>
            public string? Message { get; init; }

            /// <summary>The steps that ran, in order.</summary>
            public List<JobRunStep> Steps { get; } = new();
        }

        /// <summary>One step of one execution.</summary>
        public sealed class JobRunStep
        {
            /// <summary>Step number.</summary>
            public long StepId { get; init; }

            /// <summary>Step name.</summary>
            public string? StepName { get; init; }

            /// <summary>failed, succeeded, retry, cancelled or running.</summary>
            public required string Status { get; init; }

            /// <summary>When the step started.</summary>
            public string? At { get; init; }

            /// <summary>How long it took.</summary>
            public long Seconds { get; init; }

            /// <summary>What the step reported (the error text when it failed).</summary>
            public string? Message { get; init; }

            /// <summary>SQL error number, 0 when none.</summary>
            public long SqlMessageId { get; init; }

            /// <summary>SQL error severity, 0 when none.</summary>
            public long SqlSeverity { get; init; }

            /// <summary>Retries attempted.</summary>
            public long Retries { get; init; }
        }
    }
}
