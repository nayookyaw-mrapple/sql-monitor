using API.Configuration;

namespace API.Services
{
    /// <summary>
    /// The background work that runs for as long as the server is up: searching for databases (at start and every
    /// 30 minutes), stopping the monitoring of databases nobody views, and the always-on activity history
    /// (sampler + audit reader + retention) for the servers in HISTORY_SERVERS.
    /// </summary>
    public class MonitorHostedService : BackgroundService
    {
        private readonly MonitorConfig _config;
        private readonly Discovery _discovery;
        private readonly MonitorService _monitor;
        private readonly HistoryStore _history;
        private readonly Sampler _sampler;
        private readonly AuditReader _audit;
        private readonly ILogger<MonitorHostedService> _logger;

        /// <summary>Creates the service.</summary>
        public MonitorHostedService(MonitorConfig config, Discovery discovery, MonitorService monitor, HistoryStore history, Sampler sampler, AuditReader audit, ILogger<MonitorHostedService> logger)
        {
            _config = config;
            _discovery = discovery;
            _monitor = monitor;
            _history = history;
            _sampler = sampler;
            _audit = audit;
            _logger = logger;
        }

        /// <inheritdoc />
        protected override async Task ExecuteAsync(CancellationToken stoppingToken)
        {
            // Don't hold up the start of the web server.
            await Task.Yield();

            try
            {
                await _discovery.DiscoverTargetsAsync();
            }
            catch (Exception err)
            {
                // Unreachable servers are reported per server; anything else is retried by the 30-minute search below.
                _logger.LogError(err, "[discovery] first search for databases failed");
            }

            var work = new List<Task>
            {
                EveryAsync(TimeSpan.FromMinutes(30), stoppingToken, () => _discovery.DiscoverTargetsAsync()),
                EveryAsync(TimeSpan.FromMinutes(1), stoppingToken, () =>
                {
                    _monitor.StopIdleTargets();
                    return Task.CompletedTask;
                }),
            };
            work.AddRange(StartHistory(stoppingToken));
            await Task.WhenAll(work);
        }

        /// <summary>Always-on activity history for the servers in HISTORY_SERVERS (sampler + audit reader + retention).</summary>
        private List<Task> StartHistory(CancellationToken stop)
        {
            var work = new List<Task>();
            if (_config.History.Servers.Count == 0) return work;
            var unknown = _config.History.Servers.Where(s => !_config.Servers.Contains(s)).ToList();
            if (unknown.Count > 0) _logger.LogWarning("[history] HISTORY_SERVERS entries not in DB_SERVERS: {Servers}", string.Join(", ", unknown));

            void Prune()
            {
                try
                {
                    var n = _history.PruneHistory();
                    if (n.Sampled > 0 || n.Audit > 0)
                        _logger.LogInformation("[history] removed {Sampled} sampled and {Audit} audit rows older than {Days} days", n.Sampled, n.Audit, _config.History.RetentionDays);
                }
                catch (Exception err)
                {
                    _logger.LogError(err, "[history] prune failed");
                }
            }

            Prune();
            work.Add(EveryAsync(TimeSpan.FromHours(1), stop, () =>
            {
                Prune();
                return Task.CompletedTask;
            }));
            _logger.LogInformation("[history] saving to {Path} (kept {Days} days)", _history.HistoryDbPath(), _config.History.RetentionDays);
            work.AddRange(_sampler.Start(stop));
            work.AddRange(_audit.Start(stop));
            return work;
        }

        private async Task EveryAsync(TimeSpan interval, CancellationToken stop, Func<Task> work)
        {
            using var timer = new PeriodicTimer(interval);
            try
            {
                while (await timer.WaitForNextTickAsync(stop))
                {
                    try
                    {
                        await work();
                    }
                    catch (Exception err)
                    {
                        _logger.LogError(err, "[server] background work failed");
                    }
                }
            }
            catch (OperationCanceledException)
            {
                // stopping
            }
        }
    }
}
