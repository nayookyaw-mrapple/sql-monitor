using System.Collections.Concurrent;
using API.Infrastructure;
using API.Models;

namespace API.Services
{
    /// <summary>
    /// The databases SQL Monitor knows about, the one the current request (or background job) is working on, and
    /// the per-database state of every module. Every module reads its state through this, so the same code
    /// serves many databases at once.
    /// </summary>
    public sealed class TargetRegistry
    {
        private readonly AsyncLocal<Target?> _current = new();
        private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, object>> _states = new();
        private volatile Target? _default;
        private volatile IReadOnlyList<TargetInfo> _known = Array.Empty<TargetInfo>();

        /// <summary>The database opened first: the first DB_DATABASES entry found on the servers (set by discovery).</summary>
        public Target Default => _default ?? throw new TargetError("No databases available — check DB_SERVERS / DB_DATABASES in server/.env");

        /// <summary>Sets the default database.</summary>
        public void SetDefault(Target? target) => _default = target;

        /// <summary>The database the current request (or background job) is working on.</summary>
        public Target Current => _current.Value ?? Default;

        /// <summary>
        /// Makes <paramref name="target"/> the current database for the rest of the calling async method and
        /// everything it calls or starts. It does not leak back to the caller of that async method.
        /// </summary>
        public void Enter(Target target) => _current.Value = target;

        /// <summary>Per-database state: one instance of each named bucket per target.</summary>
        public T State<T>(string bucket, Func<T> init, Target? target = null) where T : class
        {
            var t = target ?? Current;
            var s = _states.GetOrAdd(t.Id, _ => new ConcurrentDictionary<string, object>());
            return (T)s.GetOrAdd(bucket, _ => init());
        }

        /// <summary>Databases found by discovery.</summary>
        public IReadOnlyList<TargetInfo> Known => _known;

        /// <summary>Replaces the list of databases found by discovery.</summary>
        public void SetKnown(IReadOnlyList<TargetInfo> list) => _known = list;

        /// <summary>Resolve the X-Target header (or ?target=) against the discovered databases.</summary>
        public Target From(HttpRequest req)
        {
            string? raw = req.Headers.TryGetValue("x-target", out var header) ? header.ToString() : null;
            raw ??= req.Query.TryGetValue("target", out var q) && q.Count == 1 ? q.ToString() : null;
            if (string.IsNullOrEmpty(raw)) return Default;
            var id = Uri.UnescapeDataString(raw).ToLowerInvariant();
            var t = _known.FirstOrDefault(k => k.Id == id) ?? throw new TargetError($"Unknown or unavailable database '{raw}'");
            return Target.Make(t.Server, t.Database);
        }
    }
}
