using System.Globalization;
using System.Text.RegularExpressions;

namespace API.Infrastructure
{
    /// <summary>Turns database values into the plain values sent to the browser.</summary>
    public static class Serialize
    {
        private static readonly Regex DateOnly = new(@"^\d{4}-\d{2}-\d{2}$", RegexOptions.Compiled);
        private static readonly Regex DateMinute = new(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$", RegexOptions.Compiled);

        /// <summary>Format a date in server-local wall-clock time (matches what SQL Server stored).</summary>
        public static string FormatDate(DateTime d) => d.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture);

        /// <summary>A UTC instant in ISO 8601 form, e.g. 2026-01-31T09:15:00.123Z.</summary>
        public static string IsoUtc(DateTime utc) => utc.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

        /// <summary>
        /// One value: dates as "YYYY-MM-DD HH:mm:ss.SSS", binary as a short hex preview, decimals as plain numbers.
        /// </summary>
        public static object? Value(object? v)
        {
            switch (v)
            {
                case null:
                case DBNull:
                    return null;
                case DateTime d:
                    return FormatDate(d);
                case DateTimeOffset dto:
                    return FormatDate(dto.LocalDateTime);
                case TimeSpan t:
                    return FormatDate(new DateTime(1970, 1, 1).Add(t));
                case byte[] bytes:
                    var head = Convert.ToHexString(bytes, 0, Math.Min(32, bytes.Length));
                    return $"0x{head}{(bytes.Length > 32 ? $"… ({bytes.Length} bytes)" : "")}";
                case decimal m:
                    return (double)m;
                case float f:
                    return (double)f;
                case Guid g:
                    return g.ToString().ToUpperInvariant();
                default:
                    return v;
            }
        }

        /// <summary>Every value of a row, see <see cref="Value"/>.</summary>
        public static Row Fields(Row row)
        {
            var result = new Row(row.Count);
            foreach (var (k, v) in row) result[k] = Value(v);
            return result;
        }

        /// <summary>
        /// Normalise a user date/time ("YYYY-MM-DD", "YYYY-MM-DD HH:mm", "YYYY-MM-DDTHH:mm[:ss[.mmm]]") into the full
        /// ISO 8601 form SQL Server converts unambiguously with CONVERT(datetime2, @p, 126), whatever the login's
        /// language/DATEFORMAT. End-of-range values are made inclusive of the whole minute (or day).
        /// </summary>
        public static string IsoParam(string v, bool end = false)
        {
            var s = Js.ReplaceFirst(v.Trim(), " ", "T");
            if (DateOnly.IsMatch(s)) return $"{s}T{(end ? "23:59:59.999" : "00:00:00")}";
            if (DateMinute.IsMatch(s)) return $"{s}:{(end ? "59.999" : "00")}";
            return s;
        }
    }
}
