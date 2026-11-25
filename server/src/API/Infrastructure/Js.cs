using System.Globalization;

namespace API.Infrastructure
{
    /// <summary>
    /// Small helpers that keep the behaviour of the original JavaScript server where .NET would differ
    /// (lenient integer parsing, text ordering, value-to-text conversion).
    /// </summary>
    public static class Js
    {
        /// <summary>
        /// Integer at the start of the text, like parseInt(value, 10): leading spaces and a sign are allowed and
        /// anything after the digits is ignored ("25px" is 25). Null when the text does not start with a number.
        /// </summary>
        public static long? ParseInt(string? value)
        {
            if (value is null) return null;
            var i = 0;
            while (i < value.Length && char.IsWhiteSpace(value[i])) i++;
            var negative = false;
            if (i < value.Length && (value[i] == '+' || value[i] == '-'))
            {
                negative = value[i] == '-';
                i++;
            }
            var start = i;
            long n = 0;
            while (i < value.Length && value[i] >= '0' && value[i] <= '9')
            {
                // Stop growing well before overflow; values this large are never valid here anyway.
                if (n < 100_000_000_000_000_000) n = n * 10 + (value[i] - '0');
                i++;
            }
            if (i == start) return null;
            return negative ? -n : n;
        }

        /// <summary>Replaces only the first occurrence.</summary>
        public static string ReplaceFirst(string text, string search, string replacement)
        {
            var i = text.IndexOf(search, StringComparison.Ordinal);
            return i < 0 ? text : string.Concat(text.AsSpan(0, i), replacement, text.AsSpan(i + search.Length));
        }

        /// <summary>Language-aware text order (what localeCompare gave): "a" before "B", digits before letters.</summary>
        public static int Compare(string? a, string? b) => string.Compare(a ?? "", b ?? "", StringComparison.InvariantCulture);

        /// <summary>Comparer form of <see cref="Compare"/>.</summary>
        public static readonly IComparer<string?> TextOrder = Comparer<string?>.Create(Compare);

        /// <summary>A value as text, the way it would be shown.</summary>
        public static string Str(object? value) => value switch
        {
            null => "null",
            string s => s,
            bool b => b ? "true" : "false",
            IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
            _ => value.ToString() ?? "",
        };

        /// <summary>A database or JSON value as a number, or null for null. Text holding a number is converted.</summary>
        public static object? Num(object? value)
        {
            switch (value)
            {
                case null: return null;
                case string s:
                    if (long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var l)) return l;
                    return double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : null;
                case bool b: return b ? 1 : 0;
                case decimal m: return (double)m;
                default: return value;
            }
        }

        /// <summary>A database value as a whole number (0 for null).</summary>
        public static long ToLong(object? value) => value switch
        {
            null => 0,
            string s => long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var l) ? l : 0,
            _ => Convert.ToInt64(value, CultureInfo.InvariantCulture),
        };

        /// <summary>A database value as a whole number, or null for null.</summary>
        public static long? ToNullableLong(object? value) => value is null ? null : ToLong(value);

        /// <summary>A database value as text, or null for null.</summary>
        public static string? Text(object? value) => value is null ? null : Str(value);

        /// <summary>True for true / 1.</summary>
        public static bool Truthy(object? value) => value switch
        {
            null => false,
            bool b => b,
            string s => s.Length > 0,
            _ => Convert.ToDouble(value, CultureInfo.InvariantCulture) != 0,
        };

        /// <summary>The first <paramref name="max"/> characters.</summary>
        public static string Left(string text, int max) => text.Length <= max ? text : text.Substring(0, max);

        /// <summary>Milliseconds on a clock that never goes backwards, for "how long ago" checks.</summary>
        public static long NowMs() => Environment.TickCount64;
    }
}
