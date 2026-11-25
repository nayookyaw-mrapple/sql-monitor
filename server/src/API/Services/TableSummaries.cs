using API.Configuration;
using API.Models;

namespace API.Services
{
    /// <summary>A table as shown in lists.</summary>
    public class TableSummary
    {
        /// <summary>schema.name.</summary>
        public required string FullName { get; init; }

        /// <summary>Table name.</summary>
        public required string Name { get; init; }

        /// <summary>Schema name.</summary>
        public required string Schema { get; init; }

        /// <summary>Module prefix.</summary>
        public required string Module { get; init; }

        /// <summary>Name without module prefix and "HistoryT".</summary>
        public required string DisplayName { get; init; }

        /// <summary>Physical row count (all sites/seasons).</summary>
        public long RowCount { get; init; }

        /// <summary>Number of columns.</summary>
        public int ColumnCount { get; init; }

        /// <summary>Column used for "latest first" ordering.</summary>
        public required string SortColumn { get; init; }

        /// <summary>Has the standard audit columns.</summary>
        public bool HasAuditColumns { get; init; }

        /// <summary>Row-level security filter.</summary>
        public required string Rls { get; init; }

        /// <summary>At or above the "large table" row count.</summary>
        public bool IsLarge { get; init; }

        /// <summary>Newest change for the Site/Season, when known.</summary>
        public string? LastChange { get; init; }

        /// <summary>False while the background scan has not reached this table yet.</summary>
        public bool LastChangeKnown { get; init; }
    }

    /// <summary>A table with its columns, for the table viewer.</summary>
    public sealed class TableDetail : TableSummary
    {
        /// <summary>Primary key columns.</summary>
        public required List<string> PrimaryKey { get; init; }

        /// <summary>RecordAction, when the table has it.</summary>
        public string? ActionColumn { get; init; }

        /// <summary>User column, when the table has one.</summary>
        public string? UserColumn { get; init; }

        /// <summary>The sort column when it is a date (the date-range filter applies to it).</summary>
        public string? DateColumn { get; init; }

        /// <summary>Columns in table order.</summary>
        public required List<ColumnDetail> Columns { get; init; }
    }

    /// <summary>A column, with whether the grid can sort on it.</summary>
    public sealed record ColumnDetail(string Name, string Type, int MaxLength, bool Nullable, bool IsIdentity, bool Sortable);

    /// <summary>Builds the table summaries shown in lists.</summary>
    public sealed class TableSummaries
    {
        private readonly MonitorConfig _config;
        private readonly MonitorService _monitor;

        /// <summary>Creates the builder.</summary>
        public TableSummaries(MonitorConfig config, MonitorService monitor)
        {
            _config = config;
            _monitor = monitor;
        }

        /// <summary>Summary of a table for a Site/Season.</summary>
        public TableSummary Of(TableInfo t, DataContext ctx)
        {
            var (known, last) = _monitor.GetLastChange(ctx, t.FullName);
            return new TableSummary
            {
                FullName = t.FullName,
                Name = t.Name,
                Schema = t.Schema,
                Module = t.Module,
                DisplayName = t.DisplayName,
                RowCount = t.RowCount,
                ColumnCount = t.Columns.Count,
                SortColumn = t.SortColumn,
                HasAuditColumns = t.HasAuditColumns,
                Rls = t.Rls,
                IsLarge = t.RowCount >= _config.LargeTableRows,
                LastChange = last,
                LastChangeKnown = known,
            };
        }
    }
}
