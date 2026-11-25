using System.Collections.Concurrent;
using System.Text.RegularExpressions;
using API.Infrastructure;
using API.Models;
using Microsoft.Data.SqlClient;

namespace API.Services
{
    /// <summary>Filters of the errors feed.</summary>
    public sealed record ErrorFilters(string? From = null, string? To = null, string? Search = null, string? Severity = null);

    /// <summary>One error, whatever source it came from.</summary>
    public sealed class ErrorRow
    {
        /// <summary>Source id.</summary>
        public required string Source { get; init; }

        /// <summary>Source name.</summary>
        public required string SourceLabel { get; init; }

        /// <summary>Source category.</summary>
        public required string Category { get; init; }

        /// <summary>Row id in its table.</summary>
        public object? Id { get; init; }

        /// <summary>When it happened.</summary>
        public string? At { get; init; }

        /// <summary>Where it came from.</summary>
        public object? Origin { get; init; }

        /// <summary>Error code.</summary>
        public object? Code { get; init; }

        /// <summary>Message.</summary>
        public object? Message { get; init; }

        /// <summary>User.</summary>
        public object? User { get; init; }

        /// <summary>error, warning or info.</summary>
        public required string Severity { get; init; }

        /// <summary>Extra fields for the detail panel.</summary>
        public required Row Extra { get; init; }

        /// <summary>Real table the row lives in, e.g. dbo.ma_ApplicationErrorT.</summary>
        public required string Table { get; init; }

        /// <summary>Predicate selecting this exact row, e.g. ApplErrorID = 329616.</summary>
        public string? Key { get; init; }

        /// <summary>Ready-to-run SQL (with session context when the table uses row-level security) to find the row in SSMS.</summary>
        public string? TraceSql { get; init; }
    }

    /// <summary>A source and how many errors it holds.</summary>
    public sealed class SourceStatus
    {
        /// <summary>Source id.</summary>
        public required string Id { get; init; }

        /// <summary>Source name.</summary>
        public required string Label { get; init; }

        /// <summary>Source category.</summary>
        public required string Category { get; init; }

        /// <summary>What the source holds.</summary>
        public required string Description { get; init; }

        /// <summary>Table the errors live in.</summary>
        public required string TableName { get; init; }

        /// <summary>Matching *_HistoryT table that SQL Monitor can browse, if one exists.</summary>
        public string? HistoryTable { get; init; }

        /// <summary>none, season, season_site or server.</summary>
        public required string Rls { get; init; }

        /// <summary>The source can be read.</summary>
        public bool Available { get; init; }

        /// <summary>Why it cannot be read.</summary>
        public string? UnavailableReason { get; init; }

        /// <summary>All errors.</summary>
        public long Total { get; init; }

        /// <summary>Errors in the last 24 hours.</summary>
        public long Last24h { get; init; }

        /// <summary>Errors in the last 7 days.</summary>
        public long Last7d { get; init; }

        /// <summary>Newest error.</summary>
        public string? LastAt { get; init; }
    }

    /// <summary>A source that was left out of a result, and why.</summary>
    public sealed record SkippedSource(string Source, string Reason);

    /// <summary>One page of the errors feed.</summary>
    public sealed record ErrorPage(int Page, int PageSize, long Total, long TotalPages, List<ErrorRow> Rows, List<SkippedSource> Skipped);

    /// <summary>The errors &amp; failures feed.</summary>
    public sealed class ErrorService
    {
        private static readonly HashSet<int> PermissionErrors = new() { 229, 230, 262, 297, 916, 4060, 18456 };

        /// <summary>Invalid object / column name: the source's table isn't in this database (e.g. older site databases).</summary>
        private static readonly HashSet<int> MissingErrors = new() { 207, 208 };

        private static readonly Regex MissingMessage = new("invalid (object|column) name", RegexOptions.IgnoreCase | RegexOptions.Compiled);
        private static readonly Regex PermissionMessage = new("permission was denied|login failed|cannot open database", RegexOptions.IgnoreCase | RegexOptions.Compiled);
        private static readonly Regex TrailingT = new("T$", RegexOptions.Compiled);

        private readonly Db _db;
        private readonly TargetRegistry _targets;
        private readonly Catalog _catalog;

        /// <summary>Creates the service.</summary>
        public ErrorService(Db db, TargetRegistry targets, Catalog catalog)
        {
            _db = db;
            _targets = targets;
            _catalog = catalog;
        }

        private sealed record Unavailable(string Reason, long Until, bool Missing);

        /// <summary>
        /// Sources that can't be read in the current database, re-checked later: permission errors after 5 minutes,
        /// missing tables after 30 minutes. Kept per database (target).
        /// </summary>
        private ConcurrentDictionary<string, Unavailable> UnavailableMap() =>
            _targets.State("errors.unavailable", () => new ConcurrentDictionary<string, Unavailable>());

        private static string? UnavailableKind(Exception err)
        {
            int? n = err is SqlException sql ? sql.Number : null;
            var msg = err.Message ?? "";
            if ((n is not null && MissingErrors.Contains(n.Value)) || MissingMessage.IsMatch(msg)) return "missing";
            if ((n is not null && PermissionErrors.Contains(n.Value)) || PermissionMessage.IsMatch(msg)) return "permission";
            return null;
        }

        /// <summary>Remember a source as unreadable when the error says so; returns true if it did.</summary>
        private bool MarkIfUnavailable(ErrorSource s, Exception err)
        {
            var kind = UnavailableKind(err);
            if (kind is null) return false;
            UnavailableMap()[s.Id] = new Unavailable(
                kind == "missing" ? "Not in this database" : err.Message,
                Js.NowMs() + (kind == "missing" ? 30 : 5) * 60_000,
                kind == "missing");
            return true;
        }

        private bool IsMissing(ErrorSource s) =>
            UnavailableMap().TryGetValue(s.Id, out var u) && u.Missing && UnavailableReason(s) != null;

        /// <summary>A source by id.</summary>
        public static ErrorSource? GetSource(string id) => ErrorSource.All.FirstOrDefault(s => s.Id == id);

        private string? UnavailableReason(ErrorSource s)
        {
            var map = UnavailableMap();
            if (!map.TryGetValue(s.Id, out var u)) return null;
            if (Js.NowMs() > u.Until)
            {
                map.TryRemove(s.Id, out _);
                return null;
            }
            return u.Reason;
        }

        private static (string Sql, List<SqlParam> Params) BuildWhere(ErrorSource s, ErrorFilters f)
        {
            var where = new List<string>();
            var parameters = new List<SqlParam>();
            if (!string.IsNullOrEmpty(s.Where)) where.Add($"({s.Where})");
            if (!string.IsNullOrEmpty(f.From))
            {
                where.Add($"{s.Time} >= CONVERT(datetime2, @from, 126)");
                parameters.Add(P.VarChar("from", 30, Serialize.IsoParam(f.From)));
            }
            if (!string.IsNullOrEmpty(f.To))
            {
                where.Add($"{s.Time} <= CONVERT(datetime2, @to, 126)");
                parameters.Add(P.VarChar("to", 30, Serialize.IsoParam(f.To, true)));
            }
            if (!string.IsNullOrEmpty(f.Search))
            {
                where.Add($"({s.Message} LIKE @search OR {s.Origin} LIKE @search OR ISNULL({s.Code}, '') LIKE @search)");
                parameters.Add(P.NVarChar("search", 400, $"%{f.Search}%"));
            }
            if (!string.IsNullOrEmpty(f.Severity))
            {
                where.Add($"{s.Severity} = @severity");
                parameters.Add(P.VarChar("severity", 10, f.Severity));
            }
            return (where.Count > 0 ? $"WHERE {string.Join(" AND ", where)}" : "", parameters);
        }

        private static string SelectList(ErrorSource s)
        {
            var parts = new List<string>
            {
                $"{s.IdExpr} AS id",
                $"{s.Time} AS at",
                $"{s.Origin} AS origin",
                $"{s.Code} AS code",
                $"{s.Message} AS message",
                $"{s.User} AS userName",
                $"{s.Severity} AS severity",
                $"{s.Key} AS traceKey",
            };
            parts.AddRange(s.Extra.Select((x, i) => $"{x.Expr} AS [x{i}]"));
            return string.Join(", ", parts);
        }

        /// <summary>History table for an error table, e.g. dbo.hq_ExceptionT -> dbo.hq_Exception_HistoryT.</summary>
        public string? HistoryTableFor(ErrorSource s)
        {
            if (s.Pool != PoolName.Main) return null;
            var baseName = TrailingT.Replace(s.TableName, "");
            foreach (var candidate in new[] { $"{baseName}_HistoryT", $"{baseName}HistoryT" })
            {
                var t = _catalog.GetTable(candidate);
                if (t != null) return t.FullName;
            }
            return null;
        }

        private static string? TraceSql(ErrorSource s, string? key, DataContext ctx)
        {
            if (string.IsNullOrEmpty(key)) return null;
            var lines = new List<string>();
            if (s.Pool == PoolName.Msdb) lines.Add("USE msdb;");
            if (s.Rls is "season" or "season_site")
            {
                lines.Add("-- Row-level security: set the same site/season SQL Monitor used");
                if (s.Rls == "season_site") lines.Add($"EXEC sys.sp_set_session_context @key = N'SiteID', @value = {ctx.SiteId};");
                lines.Add($"EXEC sys.sp_set_session_context @key = N'Season', @value = {ctx.Season};");
            }
            lines.Add($"SELECT * FROM {s.TableName} WHERE {key};");
            return string.Join("\n", lines);
        }

        private static ErrorRow ToRow(ErrorSource s, Row r, DataContext ctx)
        {
            var v = Serialize.Fields(r);
            var extra = new Row();
            for (var i = 0; i < s.Extra.Length; i++)
            {
                if (v.TryGetValue($"x{i}", out var x) && x is not null && x is not "") extra[s.Extra[i].Label] = x;
            }
            var key = v.GetValueOrDefault("traceKey") as string;
            var message = v.GetValueOrDefault("message");
            return new ErrorRow
            {
                Source = s.Id,
                SourceLabel = s.Label,
                Category = s.Category,
                Id = v.GetValueOrDefault("id"),
                At = Js.Text(v.GetValueOrDefault("at")),
                Origin = v.GetValueOrDefault("origin"),
                Code = v.GetValueOrDefault("code"),
                Message = message is string text ? text.Trim() : message,
                User = v.GetValueOrDefault("userName"),
                Severity = Js.Text(v.GetValueOrDefault("severity")) ?? "error",
                Extra = extra,
                Table = s.TableName,
                Key = key,
                TraceSql = TraceSql(s, key, ctx),
            };
        }

        private async Task<(List<ErrorRow> Rows, long Total)> QuerySourceAsync(ErrorSource s, ErrorFilters f, DataContext ctx, int offset, int size, CancellationToken signal)
        {
            var (whereSql, parameters) = BuildWhere(s, f);
            var context = s.Rls == "server" ? null : ctx;
            var rowsTask = _db.ReadQueryAsync(
                $"SELECT {SelectList(s)} FROM {s.From} {whereSql} ORDER BY at DESC, id DESC OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY",
                new QueryOptions
                {
                    Context = context,
                    Pool = s.Pool,
                    Dirty = true,
                    Signal = signal,
                    Params = parameters.Concat(new[] { P.Int("offset", offset), P.Int("size", size) }).ToList(),
                });
            var countTask = _db.ReadQueryAsync(
                $"SELECT COUNT_BIG(*) AS n FROM {s.From} {whereSql}",
                new QueryOptions { Context = context, Pool = s.Pool, Dirty = true, Signal = signal, Params = parameters });
            await Task.WhenAll(rowsTask, countTask);
            return (rowsTask.Result.Select(r => ToRow(s, r, ctx)).ToList(), Js.ToLong(countTask.Result.FirstOrDefault()?["n"]));
        }

        /// <summary>Errors from one source (OFFSET paging) or from all sources merged by time.</summary>
        public async Task<ErrorPage> QueryErrorsAsync(string? sourceId, ErrorFilters f, DataContext ctx, int page, int pageSize, CancellationToken signal)
        {
            var sources = !string.IsNullOrEmpty(sourceId) ? ErrorSource.All.Where(s => s.Id == sourceId).ToList() : ErrorSource.All.ToList();
            var single = !string.IsNullOrEmpty(sourceId);
            var offset = (page - 1) * pageSize;

            var results = await Task.WhenAll(sources.Select(async s =>
            {
                var reason = UnavailableReason(s);
                if (reason != null)
                {
                    return (Rows: new List<ErrorRow>(), Total: 0L, Skipped: IsMissing(s) ? null : new SkippedSource(s.Id, reason));
                }
                try
                {
                    // Merged view: each source returns its newest (offset + size) rows; the merge keeps the right page.
                    var r = single ? await QuerySourceAsync(s, f, ctx, offset, pageSize, signal) : await QuerySourceAsync(s, f, ctx, 0, offset + pageSize, signal);
                    return (r.Rows, r.Total, Skipped: (SkippedSource?)null);
                }
                catch (Exception err)
                {
                    if (signal.IsCancellationRequested) throw;
                    MarkIfUnavailable(s, err);
                    return (Rows: new List<ErrorRow>(), Total: 0L, Skipped: IsMissing(s) ? null : new SkippedSource(s.Id, err.Message));
                }
            }));

            var total = results.Sum(r => r.Total);
            IEnumerable<ErrorRow> rows = results.SelectMany(r => r.Rows);
            if (!single)
            {
                rows = rows.OrderByDescending(r => r.At ?? "", Js.TextOrder).Skip(offset).Take(pageSize);
            }
            return new ErrorPage(
                page,
                pageSize,
                total,
                Math.Max(1, (long)Math.Ceiling(total / (double)pageSize)),
                rows.ToList(),
                results.Where(r => r.Skipped != null).Select(r => r.Skipped!).ToList());
        }

        private sealed record StatsEntry(long At, List<SourceStatus> Data);

        private ConcurrentDictionary<string, StatsEntry> StatsCache() =>
            _targets.State("errors.stats", () => new ConcurrentDictionary<string, StatsEntry>());

        /// <summary>Every source that exists in the current database, with its error counts (cached 30 s).</summary>
        public async Task<List<SourceStatus>> SourceStatusesAsync(DataContext ctx, bool force = false)
        {
            var key = ctx.Key;
            var cache = StatsCache();
            if (!force && cache.TryGetValue(key, out var cached) && Js.NowMs() - cached.At < 30_000) return cached.Data;

            var data = await Task.WhenAll(ErrorSource.All.Select(async s =>
            {
                SourceStatus Build(bool available, string? unavailableReason, long total = 0, long last24h = 0, long last7d = 0, string? lastAt = null) => new()
                {
                    Id = s.Id,
                    Label = s.Label,
                    Category = s.Category,
                    Description = s.Description,
                    TableName = s.TableName,
                    HistoryTable = HistoryTableFor(s),
                    Rls = s.Rls,
                    Available = available,
                    UnavailableReason = unavailableReason,
                    Total = total,
                    Last24h = last24h,
                    Last7d = last7d,
                    LastAt = lastAt,
                };

                var reason = UnavailableReason(s);
                if (reason != null) return Build(false, reason);
                try
                {
                    var where = !string.IsNullOrEmpty(s.Where) ? $"WHERE {s.Where}" : "";
                    var rows = await _db.ReadQueryAsync(
                        $@"SELECT COUNT_BIG(*) AS total,
                                  SUM(CASE WHEN {s.Time} >= DATEADD(HOUR, -24, GETDATE()) THEN 1 ELSE 0 END) AS h24,
                                  SUM(CASE WHEN {s.Time} >= DATEADD(DAY, -7, GETDATE()) THEN 1 ELSE 0 END) AS d7,
                                  MAX({s.Time}) AS lastAt
                           FROM {s.From} {where}",
                        new QueryOptions { Context = s.Rls == "server" ? null : ctx, Pool = s.Pool, Dirty = true });
                    var r = rows.FirstOrDefault();
                    return Build(
                        true,
                        null,
                        Js.ToLong(r?["total"]),
                        Js.ToLong(r?["h24"]),
                        Js.ToLong(r?["d7"]),
                        Js.Text(Serialize.Value(r?["lastAt"])));
                }
                catch (Exception err)
                {
                    MarkIfUnavailable(s, err);
                    return Build(false, err.Message);
                }
            }));
            // Hide sources whose table doesn't exist in this database (site databases don't have every table).
            var visible = data.Where(d => !ErrorSource.All.Any(s => s.Id == d.Id && IsMissing(s))).ToList();
            cache[key] = new StatsEntry(Js.NowMs(), visible);
            return visible;
        }

        /// <summary>Most frequent error messages in the range, grouped per source.</summary>
        public async Task<List<object>> RecurringErrorsAsync(string? sourceId, string? from, string? to, DataContext ctx, CancellationToken signal)
        {
            var sources = !string.IsNullOrEmpty(sourceId) ? ErrorSource.All.Where(s => s.Id == sourceId).ToList() : ErrorSource.All.ToList();
            var groups = await Task.WhenAll(sources.Select(async s =>
            {
                var empty = new List<(long Count, object Row)>();
                if (UnavailableReason(s) != null) return empty;
                var conds = new List<string>();
                if (!string.IsNullOrEmpty(s.Where)) conds.Add($"({s.Where})");
                var parameters = new List<SqlParam>();
                if (!string.IsNullOrEmpty(from))
                {
                    conds.Add($"{s.Time} >= CONVERT(datetime2, @from, 126)");
                    parameters.Add(P.VarChar("from", 30, Serialize.IsoParam(from)));
                }
                if (!string.IsNullOrEmpty(to))
                {
                    conds.Add($"{s.Time} <= CONVERT(datetime2, @to, 126)");
                    parameters.Add(P.VarChar("to", 30, Serialize.IsoParam(to, true)));
                }
                var where = conds.Count > 0 ? string.Join(" AND ", conds) : "1 = 1";
                try
                {
                    var rows = await _db.ReadQueryAsync(
                        $@"SELECT TOP (25) {s.Origin} AS origin, LEFT({s.Message}, 300) AS message, COUNT_BIG(*) AS n, MIN({s.Time}) AS firstAt, MAX({s.Time}) AS lastAt
                           FROM {s.From} WHERE {where}
                           GROUP BY {s.Origin}, LEFT({s.Message}, 300)
                           ORDER BY n DESC",
                        new QueryOptions { Context = s.Rls == "server" ? null : ctx, Pool = s.Pool, Dirty = true, Signal = signal, Params = parameters });
                    return rows.Select(r =>
                    {
                        var count = Js.ToLong(r["n"]);
                        return (count, (object)new
                        {
                            source = s.Id,
                            sourceLabel = s.Label,
                            category = s.Category,
                            table = s.TableName,
                            origin = r["origin"],
                            message = (r["message"] as string)?.Trim(),
                            count,
                            firstAt = Serialize.Value(r["firstAt"]),
                            lastAt = Serialize.Value(r["lastAt"]),
                        });
                    }).ToList();
                }
                catch (Exception err)
                {
                    if (signal.IsCancellationRequested) throw;
                    MarkIfUnavailable(s, err);
                    return empty;
                }
            }));
            return groups.SelectMany(g => g).OrderByDescending(g => g.Item1).Take(100).Select(g => g.Item2).ToList();
        }

        /// <summary>The script a DBA runs to let a login read SQL Agent job history.</summary>
        public static string AgentGrantScript(string user) => string.Join("\n", new[]
        {
            "-- Run as a sysadmin on the SQL Server that hosts the Agent jobs.",
            "-- Gives read-only access to job history; nothing else.",
            "USE msdb;",
            $"IF USER_ID('{user}') IS NULL CREATE USER [{user}] FOR LOGIN [{user}];",
            $"GRANT SELECT ON dbo.sysjobs TO [{user}];",
            $"GRANT SELECT ON dbo.sysjobhistory TO [{user}];",
            $"GRANT SELECT ON dbo.sysjobsteps TO [{user}];",
        });
    }
}
