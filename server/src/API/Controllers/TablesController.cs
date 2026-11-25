using System.Diagnostics;
using System.Text.RegularExpressions;
using API.Configuration;
using API.Infrastructure;
using API.Services;
using Microsoft.AspNetCore.Mvc;

namespace API.Controllers
{
    /// <summary>The history tables and their rows.</summary>
    [ApiController]
    [Route("api/tables")]
    [Produces("application/json")]
    public class TablesController : ControllerBase
    {
        private static readonly HashSet<string> Numeric = new() { "int", "bigint", "smallint", "tinyint", "decimal", "numeric", "float", "real", "money", "smallmoney", "bit" };
        private static readonly HashSet<string> Unsortable = new() { "text", "ntext", "image", "xml", "geography", "geometry", "hierarchyid", "sql_variant", "varbinary", "binary" };
        private static readonly Regex Number = new(@"^-?\d+(\.\d+)?$", RegexOptions.Compiled);

        private readonly MonitorConfig _config;
        private readonly Db _db;
        private readonly Catalog _catalog;
        private readonly ContextService _context;
        private readonly TableSummaries _summaries;

        /// <summary>Creates the controller.</summary>
        public TablesController(MonitorConfig config, Db db, Catalog catalog, ContextService context, TableSummaries summaries)
        {
            _config = config;
            _db = db;
            _catalog = catalog;
            _context = context;
            _summaries = summaries;
        }

        private TableInfo RequireTable(string name) => _catalog.GetTable(name) ?? throw new HttpError(404, $"Unknown table '{name}'");

        /// <summary>All tables, optionally of one module or matching a search text.</summary>
        [HttpGetOrHead("")]
        public IActionResult List()
        {
            var ctx = _context.From(Request);
            var module = Request.Str("module");
            var search = Request.Str("search")?.ToLowerInvariant();
            var list = _catalog.GetTables()
                .Where(t => module is null || t.Module == module)
                .Where(t => search is null || t.FullName.ToLowerInvariant().Contains(search, StringComparison.Ordinal))
                .Select(t => _summaries.Of(t, ctx))
                .OrderBy(t => t.Name, Js.TextOrder)
                .ToList();
            return Ok(list);
        }

        /// <summary>One table with its columns.</summary>
        [HttpGetOrHead("{name}")]
        public IActionResult Detail(string name)
        {
            var ctx = _context.From(Request);
            var t = RequireTable(name);
            var s = _summaries.Of(t, ctx);
            return Ok(new TableDetail
            {
                FullName = s.FullName,
                Name = s.Name,
                Schema = s.Schema,
                Module = s.Module,
                DisplayName = s.DisplayName,
                RowCount = s.RowCount,
                ColumnCount = s.ColumnCount,
                SortColumn = s.SortColumn,
                HasAuditColumns = s.HasAuditColumns,
                Rls = s.Rls,
                IsLarge = s.IsLarge,
                LastChange = s.LastChange,
                LastChangeKnown = s.LastChangeKnown,
                PrimaryKey = t.PrimaryKey,
                ActionColumn = t.ActionColumn,
                UserColumn = t.UserColumn,
                DateColumn = t.Columns.Any(c => c.Name == t.SortColumn && Catalog.DateTypes.Contains(c.Type)) ? t.SortColumn : null,
                Columns = t.Columns.Select(c => new ColumnDetail(c.Name, c.Type, c.MaxLength, c.Nullable, c.IsIdentity, !Unsortable.Contains(c.Type))).ToList(),
            });
        }

        /// <summary>The record actions found in a table, for the action filter.</summary>
        [HttpGetOrHead("{name}/actions")]
        public async Task<IActionResult> Actions(string name)
        {
            var ctx = _context.From(Request);
            var t = RequireTable(name);
            if (t.ActionColumn is null) return Ok(Array.Empty<string>());
            if (t.RowCount > _config.LastChangeScanMaxRows) return Ok(new[] { "Record Inserted", "Record Updated", "Record Deleted" });
            var rows = await _db.ReadQueryAsync(
                $"SELECT DISTINCT TOP (50) {Db.Q(t.ActionColumn)} AS v FROM {Catalog.Qualified(t)} WHERE {Db.Q(t.ActionColumn)} IS NOT NULL ORDER BY v",
                new QueryOptions { Dirty = true, Context = ctx, Signal = HttpContext.RequestAborted });
            return Ok(rows.Select(r => r["v"]).ToList());
        }

        /// <summary>One page of a table's rows, newest first by default, with optional filters.</summary>
        [HttpGetOrHead("{name}/rows")]
        public async Task<IActionResult> Rows(string name)
        {
            var ctx = _context.From(Request);
            var t = RequireTable(name);
            var timer = Stopwatch.StartNew();

            var page = Request.Page();
            var pageSize = Request.PageSize();

            var sortName = (Request.Str("sort") ?? t.SortColumn).ToLowerInvariant();
            var sortCol = t.Columns.FirstOrDefault(c => c.Name.ToLowerInvariant() == sortName);
            if (sortCol is null || Unsortable.Contains(sortCol.Type)) throw new HttpError(400, "Invalid sort column");
            var dir = (Request.Query.TryGetValue("dir", out var d) ? d.ToString() : "desc").ToLowerInvariant() == "asc" ? "ASC" : "DESC";

            var where = new List<string>();
            var parameters = new List<SqlParam>();
            var dateCol = t.Columns.FirstOrDefault(c => c.Name == t.SortColumn && Catalog.DateTypes.Contains(c.Type));

            var from = Request.Str("from");
            var to = Request.Str("to");
            if ((from != null || to != null) && dateCol is null) throw new HttpError(400, "This table has no date column to filter on");
            if (from != null)
            {
                if (!RequestExtensions.IsLocalDateTime(from)) throw new HttpError(400, "Invalid \"from\" date");
                where.Add($"{Db.Q(dateCol!.Name)} >= CONVERT(datetime2, @from, 126)");
                parameters.Add(P.VarChar("from", 30, Serialize.IsoParam(from)));
            }
            if (to != null)
            {
                if (!RequestExtensions.IsLocalDateTime(to)) throw new HttpError(400, "Invalid \"to\" date");
                where.Add($"{Db.Q(dateCol!.Name)} <= CONVERT(datetime2, @to, 126)");
                parameters.Add(P.VarChar("to", 30, Serialize.IsoParam(to, true)));
            }

            var action = Request.Str("action");
            if (action != null && t.ActionColumn != null)
            {
                where.Add($"{Db.Q(t.ActionColumn)} = @action");
                parameters.Add(P.VarChar("action", 50, action));
            }

            var user = Request.Str("user");
            if (user != null && t.UserColumn != null)
            {
                where.Add($"{Db.Q(t.UserColumn)} LIKE @user");
                parameters.Add(P.NVarChar("user", 260, $"%{user}%"));
            }

            var filterColumn = Request.Str("filterColumn");
            var filterValue = Request.Str("filterValue");
            if (filterColumn != null && filterValue != null)
            {
                var fc = t.Columns.FirstOrDefault(c => c.Name.ToLowerInvariant() == filterColumn.ToLowerInvariant()) ?? throw new HttpError(400, "Invalid filter column");
                if (Numeric.Contains(fc.Type))
                {
                    if (!Number.IsMatch(filterValue)) throw new HttpError(400, $"\"{fc.Name}\" is numeric — enter a number");
                    where.Add($"{Db.Q(fc.Name)} = TRY_CAST(@fv AS decimal(38, 10))");
                    parameters.Add(P.VarChar("fv", 60, filterValue));
                }
                else if (fc.Type == "uniqueidentifier")
                {
                    where.Add($"{Db.Q(fc.Name)} = TRY_CAST(@fv AS uniqueidentifier)");
                    parameters.Add(P.VarChar("fv", 60, filterValue));
                }
                else if (Catalog.DateTypes.Contains(fc.Type))
                {
                    if (!RequestExtensions.IsLocalDateTime(filterValue)) throw new HttpError(400, "Use YYYY-MM-DD for date columns");
                    where.Add($"CAST({Db.Q(fc.Name)} AS date) = CAST(@fv AS date)");
                    parameters.Add(P.VarChar("fv", 30, filterValue));
                }
                else if (!Unsortable.Contains(fc.Type) || fc.Type == "text" || fc.Type == "ntext")
                {
                    where.Add($"CAST({Db.Q(fc.Name)} AS nvarchar(max)) LIKE @fv");
                    parameters.Add(P.NVarChar("fv", 4000, $"%{filterValue}%"));
                }
                else
                {
                    throw new HttpError(400, $"Cannot filter on {fc.Type} column");
                }
            }

            var whereSql = where.Count > 0 ? $"WHERE {string.Join(" AND ", where)}" : "";
            var orderSql = string.Join(", ", new[] { $"{Db.Q(sortCol.Name)} {dir}" }.Concat(t.PrimaryKey.Where(k => k != sortCol.Name).Select(k => $"{Db.Q(k)} {dir}")));
            var pageParams = parameters.Concat(new[] { P.Int("offset", (page - 1) * pageSize), P.Int("size", pageSize) }).ToList();

            var signal = HttpContext.RequestAborted;
            // Metadata row counts are only valid when nothing filters the rows (no WHERE, no row-level security).
            var exactCountNeeded = where.Count > 0 || t.Rls != "none";

            var rowsTask = _db.ReadQueryAsync(
                $"SELECT * FROM {Catalog.Qualified(t)} {whereSql} ORDER BY {orderSql} OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY",
                new QueryOptions { Params = pageParams, Signal = signal, Dirty = true, Context = ctx });
            var countTask = exactCountNeeded
                ? _db.ReadQueryAsync($"SELECT COUNT_BIG(*) AS n FROM {Catalog.Qualified(t)} {whereSql}", new QueryOptions { Params = parameters, Signal = signal, Dirty = true, Context = ctx })
                : Task.FromResult(new List<Row> { new() { ["n"] = t.RowCount } });
            await Task.WhenAll(rowsTask, countTask);

            var total = Js.ToLong(countTask.Result.FirstOrDefault()?["n"]);
            return Ok(new
            {
                table = t.FullName,
                context = ctx,
                page,
                pageSize,
                total,
                totalPages = Math.Max(1, (long)Math.Ceiling(total / (double)pageSize)),
                totalIsEstimate = !exactCountNeeded,
                sort = sortCol.Name,
                dir = dir.ToLowerInvariant(),
                elapsedMs = timer.ElapsedMilliseconds,
                rows = rowsTask.Result.Select(Serialize.Fields).ToList(),
            });
        }
    }
}
