using System.Collections.Concurrent;
using System.Text.RegularExpressions;
using API.Configuration;
using API.Infrastructure;
using API.Models;

namespace API.Services
{
    /// <summary>A change in a table's row count, seen by the row-count poll.</summary>
    public sealed record ActivityEvent(long Id, string Table, string Module, string DisplayName, long Delta, long RowCount, string DetectedAt);

    /// <summary>One of the newest rows of a history table.</summary>
    public sealed record LatestChangeRow(string Table, string Module, string DisplayName, string? ChangedAt, object? Action, object? User, Row Summary);

    /// <summary>Optional filters for the latest-changes feed. User and Table match part of the value.</summary>
    public sealed record LatestFilter(string? Action = null, string? User = null, string? Table = null);

    /// <summary>State of the background monitoring of one database, for the UI.</summary>
    public sealed class MonitorStatus
    {
        /// <summary>When monitoring of this database started.</summary>
        public required string StartedAt { get; init; }

        /// <summary>Last successful row-count poll.</summary>
        public string? LastPollAt { get; init; }

        /// <summary>Error of the last row-count poll, if it failed.</summary>
        public string? LastPollError { get; init; }

        /// <summary>Row-count poll interval.</summary>
        public int PollIntervalMs { get; init; }

        /// <summary>When the last full "last change" scan finished for the Site/Season.</summary>
        public string? LastChangeScanAt { get; init; }

        /// <summary>A "last change" scan is running for the Site/Season.</summary>
        public bool LastChangeScanRunning { get; init; }

        /// <summary>Tables scanned so far for the Site/Season.</summary>
        public int LastChangeScannedTables { get; init; }

        /// <summary>Tables above this row count are not scanned.</summary>
        public int LastChangeScanMaxRows { get; init; }

        /// <summary>Row-count changes recorded since monitoring started.</summary>
        public long EventsRecorded { get; init; }
    }

    /// <summary>
    /// Background monitoring of each database someone is viewing: row-count polling (live activity), the newest rows
    /// of every small table per Site/Season (latest changes, last change), and starting/stopping all of that.
    /// </summary>
    public sealed class MonitorService : IDisposable
    {
        private const int MaxEvents = 1000;
        private const int MaxContexts = 6;
        private static readonly Regex AuditCols = new("^(History|Created|Modified|DateModified|CreateDate|RecordAction|Season$|SiteID$)", RegexOptions.IgnoreCase | RegexOptions.Compiled);

        private readonly MonitorConfig _config;
        private readonly Db _db;
        private readonly TargetRegistry _targets;
        private readonly Catalog _catalog;
        private readonly ContextService _context;
        private readonly ILogger<MonitorService> _logger;

        /// <summary>Creates the service.</summary>
        public MonitorService(MonitorConfig config, Db db, TargetRegistry targets, Catalog catalog, ContextService context, ILogger<MonitorService> logger)
        {
            _config = config;
            _db = db;
            _targets = targets;
            _catalog = catalog;
            _context = context;
            _logger = logger;
        }

        /// <summary>Per Site/Season cache of each small table's newest rows.</summary>
        private sealed class ContextCache
        {
            public required DataContext Ctx { get; init; }
            /// <summary>Newest change per table; a null value means the table has no rows for this Site/Season.</summary>
            public ConcurrentDictionary<string, string?> LastChange { get; } = new();
            public ConcurrentDictionary<string, List<LatestChangeRow>> LatestRows { get; } = new();
            /// <summary>Tables waiting for a rescan; guarded by lock(this).</summary>
            public HashSet<string> Pending { get; } = new();
            public bool Scanning;
            public DateTime? LastScanAt;
            public long LastUsed;
        }

        private sealed record RangeEntry(long At, List<LatestChangeRow> Rows, int Scanned);

        /// <summary>Monitoring state of one database (one per target). Guarded by lock(Sync).</summary>
        private sealed class State
        {
            public readonly object Sync = new();
            public readonly List<ActivityEvent> Events = new();
            public long NextEventId = 1;
            public Dictionary<string, long> LastCounts = new();
            public DateTime? LastPollAt;
            public string? LastPollError;
            public DateTime StartedAt = DateTime.Now;
            public readonly Dictionary<string, ContextCache> Caches = new();
            public readonly Dictionary<string, RangeEntry> RangeCache = new();
        }

        private State Mon() => _targets.State("monitor", () => new State());

        private void Forget(Task task) =>
            task.ContinueWith(t => _logger.LogError(t.Exception, "[monitor] background work failed"), TaskContinuationOptions.OnlyOnFaulted);

        /// <summary>Get (and start populating) the cache for a Site/Season.</summary>
        private ContextCache CacheFor(DataContext ctx)
        {
            var m = Mon();
            ContextCache? c;
            var created = false;
            lock (m.Sync)
            {
                var key = ctx.Key;
                if (!m.Caches.TryGetValue(key, out c))
                {
                    if (m.Caches.Count >= MaxContexts)
                    {
                        var oldest = m.Caches.Where(e => !e.Value.Scanning).OrderBy(e => e.Value.LastUsed).Select(e => e.Key).FirstOrDefault();
                        if (oldest != null) m.Caches.Remove(oldest);
                    }
                    c = new ContextCache { Ctx = ctx, LastUsed = Js.NowMs() };
                    m.Caches[key] = c;
                    created = true;
                }
                c.LastUsed = Js.NowMs();
            }
            if (created) Forget(RunScanAsync(c));
            return c;
        }

        /// <summary>Newest row-count changes, newest first.</summary>
        public List<ActivityEvent> GetEvents(int limit, long sinceId = 0)
        {
            var m = Mon();
            lock (m.Sync)
            {
                var filtered = m.Events.Where(e => e.Id > sinceId).ToList();
                var tail = filtered.Skip(Math.Max(0, filtered.Count - limit)).ToList();
                tail.Reverse();
                return tail;
            }
        }

        /// <summary>
        /// Newest change of a table for a Site/Season. Known = false while the background scan has not reached the
        /// table yet; a known null value means the table has no rows for that Site/Season.
        /// </summary>
        public (bool Known, string? Value) GetLastChange(DataContext ctx, string fullName)
        {
            return CacheFor(ctx).LastChange.TryGetValue(fullName.ToLowerInvariant(), out var v) ? (true, v) : (false, null);
        }

        /// <summary>State of the monitoring of the current database (and of one Site/Season, when given).</summary>
        public MonitorStatus Status(DataContext? ctx = null)
        {
            var m = Mon();
            var c = ctx != null ? CacheFor(ctx) : null;
            lock (m.Sync)
            {
                return new MonitorStatus
                {
                    StartedAt = Serialize.FormatDate(m.StartedAt),
                    LastPollAt = m.LastPollAt is { } p ? Serialize.FormatDate(p) : null,
                    LastPollError = m.LastPollError,
                    PollIntervalMs = _config.ActivityPollMs,
                    LastChangeScanAt = c?.LastScanAt is { } s ? Serialize.FormatDate(s) : null,
                    LastChangeScanRunning = c?.Scanning ?? false,
                    LastChangeScannedTables = c?.LastChange.Count ?? 0,
                    LastChangeScanMaxRows = _config.LastChangeScanMaxRows,
                    EventsRecorded = m.NextEventId - 1,
                };
            }
        }

        /// <summary>Rows read per table: more when a filter narrows the result, so matches are not cut off at 25.</summary>
        public static int LatestPerTable(LatestFilter f)
        {
            if (!string.IsNullOrEmpty(f.Table)) return 200;
            return !string.IsNullOrEmpty(f.User) || !string.IsNullOrEmpty(f.Action) ? 100 : 25;
        }

        private static bool Has(object? value, string part) =>
            (value is null ? "" : Js.Str(value)).ToLowerInvariant().Contains(part.ToLowerInvariant(), StringComparison.Ordinal);

        /// <summary>
        /// Newest history rows inside a date range, across all tables up to the scan threshold.
        /// Only tables whose newest change (from the background scan) falls inside the range are
        /// queried, so "last 7 days" touches just the handful of tables that actually changed.
        /// </summary>
        public async Task<(List<LatestChangeRow> Rows, int ScannedTables)> GetLatestChangesInRangeAsync(
            DataContext ctx, int limit, string? module, string? from, string? to, CancellationToken signal, LatestFilter filter)
        {
            var m = Mon();
            var key = $"{ctx.Key}|{module ?? ""}|{from ?? ""}|{to ?? ""}|{limit}|{filter.Action}\u0001{filter.User}\u0001{filter.Table}";
            lock (m.Sync)
            {
                if (m.RangeCache.TryGetValue(key, out var hit) && Js.NowMs() - hit.At < 20_000) return (hit.Rows, hit.Scanned);
            }

            var cache = CacheFor(ctx);
            var fromCmp = from is null ? null : Js.ReplaceFirst(from, "T", " ");
            var candidates = _catalog.GetTables().Where(t =>
            {
                if (!string.IsNullOrEmpty(module) && t.Module != module) return false;
                if (!string.IsNullOrEmpty(filter.Table) && !Has(t.FullName, filter.Table)) return false;
                if (!string.IsNullOrEmpty(filter.Action) && t.ActionColumn is null) return false;
                if (!string.IsNullOrEmpty(filter.User) && t.UserColumn is null) return false;
                if (t.RowCount > _config.LastChangeScanMaxRows) return false;
                if (!t.Columns.Any(c => c.Name == t.SortColumn && Catalog.DateTypes.Contains(c.Type))) return false;
                if (cache.LastChange.TryGetValue(t.FullName.ToLowerInvariant(), out var last))
                {
                    if (last is null) return false; // table has no rows for this site/season
                    if (!string.IsNullOrEmpty(fromCmp) && string.CompareOrdinal(last, fromCmp) < 0) return false; // nothing newer than the range start
                }
                return true;
            }).ToList();

            var perTable = LatestPerTable(filter);
            var parameters = new List<SqlParam>();
            if (!string.IsNullOrEmpty(from)) parameters.Add(P.VarChar("from", 30, Serialize.IsoParam(from)));
            if (!string.IsNullOrEmpty(to)) parameters.Add(P.VarChar("to", 30, Serialize.IsoParam(to, true)));
            if (!string.IsNullOrEmpty(filter.Action)) parameters.Add(P.NVarChar("action", 200, filter.Action));
            if (!string.IsNullOrEmpty(filter.User)) parameters.Add(P.NVarChar("user", 200, filter.User));

            var found = new ConcurrentBag<(int Order, List<LatestChangeRow> Rows)>();
            var queue = new ConcurrentQueue<(int Order, TableInfo Table)>(candidates.Select((t, i) => (i, t)));
            await Task.WhenAll(Enumerable.Range(0, 4).Select(async _ =>
            {
                while (queue.TryDequeue(out var item))
                {
                    var t = item.Table;
                    var col = Db.Q(t.SortColumn);
                    var w = new List<string>();
                    if (!string.IsNullOrEmpty(from)) w.Add($"{col} >= CONVERT(datetime2, @from, 126)");
                    if (!string.IsNullOrEmpty(to)) w.Add($"{col} <= CONVERT(datetime2, @to, 126)");
                    if (!string.IsNullOrEmpty(filter.Action)) w.Add($"{Db.Q(t.ActionColumn!)} = @action");
                    if (!string.IsNullOrEmpty(filter.User)) w.Add($"CHARINDEX(@user, {Db.Q(t.UserColumn!)}) > 0");
                    var order = new[] { $"{col} DESC" }.Concat(t.PrimaryKey.Where(k => k != t.SortColumn).Select(k => $"{Db.Q(k)} DESC"));
                    try
                    {
                        var rows = await _db.ReadQueryAsync(
                            $"SELECT TOP ({perTable}) * FROM {Catalog.Qualified(t)} {(w.Count > 0 ? $"WHERE {string.Join(" AND ", w)}" : "")} ORDER BY {string.Join(", ", order)}",
                            new QueryOptions { Params = parameters, Context = ctx, Dirty = true, Signal = signal });
                        found.Add((item.Order, rows.Select(raw => ToLatestRow(t, Serialize.Fields(raw))).ToList()));
                    }
                    catch (Exception err)
                    {
                        if (signal.IsCancellationRequested) throw;
                        _logger.LogWarning("[monitor] range query failed for {Table}: {Message}", t.FullName, err.Message);
                    }
                }
            }));

            var result = found.OrderBy(f => f.Order).SelectMany(f => f.Rows)
                .OrderByDescending(r => r.ChangedAt ?? "", Js.TextOrder)
                .Take(limit)
                .ToList();
            lock (m.Sync)
            {
                m.RangeCache[key] = new RangeEntry(Js.NowMs(), result, candidates.Count);
                if (m.RangeCache.Count > 50) m.RangeCache.Remove(m.RangeCache.OrderBy(e => e.Value.At).First().Key);
            }
            return (result, candidates.Count);
        }

        private static LatestChangeRow ToLatestRow(TableInfo t, Row r)
        {
            r.TryGetValue(t.SortColumn, out var v);
            object? action = null;
            object? user = null;
            if (t.ActionColumn != null) r.TryGetValue(t.ActionColumn, out action);
            if (t.UserColumn != null) r.TryGetValue(t.UserColumn, out user);
            return new LatestChangeRow(t.FullName, t.Module, t.DisplayName, v is null ? null : Js.Str(v), action, user, SummaryOf(t, r));
        }

        /// <summary>Newest rows of every table (all time), straight from the background cache.</summary>
        public List<LatestChangeRow> GetLatestChanges(DataContext ctx, int limit, string? module, LatestFilter filter)
        {
            var all = new List<LatestChangeRow>();
            foreach (var rows in CacheFor(ctx).LatestRows.OrderBy(e => e.Key, StringComparer.Ordinal).Select(e => e.Value))
            {
                foreach (var r in rows)
                {
                    if (!string.IsNullOrEmpty(module) && r.Module != module) continue;
                    if (!string.IsNullOrEmpty(filter.Table) && !Has(r.Table, filter.Table)) continue;
                    if (!string.IsNullOrEmpty(filter.Action) && (r.Action is null ? "" : Js.Str(r.Action)).ToLowerInvariant() != filter.Action.ToLowerInvariant()) continue;
                    if (!string.IsNullOrEmpty(filter.User) && !Has(r.User, filter.User)) continue;
                    all.Add(r);
                }
            }
            return all.OrderByDescending(r => r.ChangedAt ?? "", Js.TextOrder).Take(limit).ToList();
        }

        private async Task PollRowCountsAsync()
        {
            var m = Mon();
            try
            {
                var counts = await _catalog.FetchRowCountsAsync();
                var now = DateTime.Now;
                var changed = new List<string>();
                List<ContextCache> caches;
                lock (m.Sync)
                {
                    foreach (var (key, count) in counts)
                    {
                        var t = _catalog.GetTable(key);
                        if (t is null) continue;
                        t.RowCount = count;
                        if (m.LastCounts.Count == 0 || !m.LastCounts.TryGetValue(key, out var prev) || prev == count) continue;
                        m.Events.Add(new ActivityEvent(m.NextEventId++, t.FullName, t.Module, t.DisplayName, count - prev, count, Serialize.FormatDate(now)));
                        if (count <= _config.LastChangeScanMaxRows) changed.Add(key);
                    }
                    if (m.Events.Count > MaxEvents) m.Events.RemoveRange(0, m.Events.Count - MaxEvents);
                    m.LastCounts = counts;
                    m.LastPollAt = now;
                    m.LastPollError = null;
                    caches = m.Caches.Values.ToList();
                }
                // Refresh the newest rows of changed tables for every Site/Season someone is looking at.
                if (changed.Count > 0)
                {
                    foreach (var c in caches)
                    {
                        List<string>? pending = null;
                        lock (c)
                        {
                            foreach (var k in changed) c.Pending.Add(k);
                            if (!c.Scanning) pending = c.Pending.ToList();
                        }
                        if (pending != null) Forget(RunScanAsync(c, pending));
                    }
                }
            }
            catch (Exception err)
            {
                lock (m.Sync) m.LastPollError = err.Message;
                _logger.LogError("[monitor] {Target}: row count poll failed: {Message}", _targets.Current.Id, err.Message);
            }
        }

        private static Row SummaryOf(TableInfo t, Row row)
        {
            var summary = new Row();
            foreach (var c in t.Columns)
            {
                if (summary.Count >= 4) break;
                if (AuditCols.IsMatch(c.Name) || c.Type == "uniqueidentifier") continue;
                if (!row.TryGetValue(c.Name, out var v) || v is null || v is "") continue;
                summary[c.Name] = v;
            }
            return summary;
        }

        private async Task ScanTableAsync(ContextCache c, TableInfo t)
        {
            var sortCol = t.SortColumn;
            var order = new[] { $"{Db.Q(sortCol)} DESC" }.Concat(t.PrimaryKey.Where(k => k != sortCol).Select(k => $"{Db.Q(k)} DESC"));
            var rows = await _db.ReadQueryAsync(
                $"SELECT TOP (5) * FROM {Catalog.Qualified(t)} ORDER BY {string.Join(", ", order)}",
                new QueryOptions { Dirty = true, Context = c.Ctx });
            var key = t.FullName.ToLowerInvariant();
            var serialized = rows.Select(Serialize.Fields).ToList();
            object? newest = null;
            if (serialized.Count > 0) serialized[0].TryGetValue(sortCol, out newest);
            c.LastChange[key] = newest is null ? null : Js.Str(newest);
            c.LatestRows[key] = serialized.Select(r => ToLatestRow(t, r)).ToList();
        }

        private async Task RunScanAsync(ContextCache c, List<string>? keys = null)
        {
            lock (c)
            {
                if (c.Scanning) return;
                c.Scanning = true;
            }
            try
            {
                var source = keys != null ? keys.Select(k => _catalog.GetTable(k)).Where(t => t != null).Select(t => t!) : _catalog.GetTables();
                var tables = source.Where(t => t.RowCount <= _config.LastChangeScanMaxRows).OrderBy(t => t.RowCount).ToList();
                if (keys != null)
                {
                    lock (c)
                    {
                        foreach (var k in keys) c.Pending.Remove(k);
                    }
                }
                var queue = new ConcurrentQueue<TableInfo>(tables);
                await Task.WhenAll(Enumerable.Range(0, 3).Select(async _ =>
                {
                    while (queue.TryDequeue(out var t))
                    {
                        try
                        {
                            await ScanTableAsync(c, t);
                        }
                        catch (Exception err)
                        {
                            _logger.LogWarning("[monitor] last-change scan failed for {Table} ({Context}): {Message}", t.FullName, c.Ctx.Key, err.Message);
                        }
                    }
                }));
                if (keys == null)
                {
                    c.LastScanAt = DateTime.Now;
                    _logger.LogInformation("[monitor] {Target}: last-change scan finished for site:season {Context} ({Count} tables)", _targets.Current.Id, c.Ctx.Key, c.LastChange.Count);
                }
            }
            finally
            {
                lock (c) c.Scanning = false;
            }
            List<string> left;
            lock (c) left = c.Pending.ToList();
            if (left.Count > 0) Forget(RunScanAsync(c, left));
        }

        /* ---------------- Activation per database ---------------- */

        private sealed class Activation
        {
            public Task Ready = Task.CompletedTask;
            public readonly CancellationTokenSource Stop = new();
            public long LastUsed;
        }

        private readonly Dictionary<string, Activation> _activations = new();

        /// <summary>
        /// Start monitoring a database the first time someone looks at it: load its catalog and site/season
        /// lists, take a row-count baseline, and start the background timers. Databases nobody views are
        /// stopped again (see <see cref="StopIdleTargets"/>) so production servers are only polled while someone is watching.
        /// </summary>
        public Task EnsureTargetAsync(Target target)
        {
            lock (_activations)
            {
                if (_activations.TryGetValue(target.Id, out var existing))
                {
                    existing.LastUsed = Js.NowMs();
                    return existing.Ready;
                }
                var a = new Activation { LastUsed = Js.NowMs() };
                a.Ready = ActivateAsync(target, a);
                _activations[target.Id] = a;
                return a.Ready;
            }
        }

        private async Task ActivateAsync(Target target, Activation a)
        {
            // Leave the caller's lock, and its request, behind: this work belongs to the database, not to one request.
            await Task.Yield();
            _targets.Enter(target);
            try
            {
                await _catalog.LoadCatalogAsync();
                await _context.LoadContextOptionsAsync();
                var m = Mon();
                lock (m.Sync)
                {
                    m.LastCounts = new Dictionary<string, long>(); // fresh baseline: don't report changes made while nobody was watching
                    m.StartedAt = DateTime.Now;
                }
                await PollRowCountsAsync();

                var stop = a.Stop.Token;
                Forget(EveryAsync(_config.ActivityPollMs, stop, PollRowCountsAsync));
                Forget(EveryAsync(_config.LastChangeRefreshMs, stop, () =>
                {
                    var now = Js.NowMs();
                    var state = Mon();
                    List<ContextCache> rescan;
                    lock (state.Sync)
                    {
                        foreach (var key in state.Caches.Where(e => now - e.Value.LastUsed > _config.TargetIdleMs).Select(e => e.Key).ToList())
                            state.Caches.Remove(key);
                        rescan = state.Caches.Values.ToList();
                    }
                    foreach (var c in rescan) Forget(RunScanAsync(c));
                    return Task.CompletedTask;
                }));
                Forget(EveryAsync(_config.CatalogRefreshMs, stop, async () =>
                {
                    try
                    {
                        await Task.WhenAll(_catalog.LoadCatalogAsync(), _context.LoadContextOptionsAsync());
                        var state = Mon();
                        lock (state.Sync)
                        {
                            foreach (var (key, count) in state.LastCounts)
                            {
                                var t = _catalog.GetTable(key);
                                if (t != null) t.RowCount = count;
                            }
                        }
                    }
                    catch (Exception err)
                    {
                        _logger.LogError(err, "[catalog] {Target}: refresh failed", target.Id);
                    }
                }));
            }
            catch
            {
                lock (_activations)
                {
                    if (_activations.TryGetValue(target.Id, out var current) && ReferenceEquals(current, a)) _activations.Remove(target.Id);
                }
                a.Stop.Cancel();
                throw;
            }
        }

        /// <summary>Runs <paramref name="work"/> every <paramref name="intervalMs"/> until stopped. A slow run delays the next one instead of overlapping it.</summary>
        private async Task EveryAsync(int intervalMs, CancellationToken stop, Func<Task> work)
        {
            using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(Math.Max(1, intervalMs)));
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
                        _logger.LogError(err, "[monitor] background work failed");
                    }
                }
            }
            catch (OperationCanceledException)
            {
                // stopped
            }
        }

        /// <summary>Stops monitoring the databases nobody has viewed for TARGET_IDLE_MS.</summary>
        public void StopIdleTargets()
        {
            var now = Js.NowMs();
            lock (_activations)
            {
                foreach (var (id, a) in _activations.ToList())
                {
                    if (now - a.LastUsed < _config.TargetIdleMs) continue;
                    a.Stop.Cancel();
                    _activations.Remove(id);
                    _logger.LogInformation("[monitor] {Target}: stopped (idle)", id);
                }
            }
        }

        /// <summary>Ids of the databases being monitored right now.</summary>
        public List<string> ActiveTargets()
        {
            lock (_activations) return _activations.Keys.ToList();
        }

        /// <inheritdoc />
        public void Dispose()
        {
            lock (_activations)
            {
                foreach (var a in _activations.Values) a.Stop.Cancel();
                _activations.Clear();
            }
        }
    }
}
