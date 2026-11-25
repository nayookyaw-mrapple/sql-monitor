using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Mvc.Routing;

namespace API.Infrastructure
{
    /// <summary>GET route that also answers HEAD (every route of this read-only API).</summary>
    public sealed class HttpGetOrHeadAttribute : HttpMethodAttribute
    {
        private static readonly string[] Methods = { "GET", "HEAD" };

        /// <summary>Creates the route.</summary>
        public HttpGetOrHeadAttribute(string template) : base(Methods, template) { }
    }

    /// <summary>Reading query-string values the lenient way the UI expects.</summary>
    public static class RequestExtensions
    {
        /// <summary>Allowed page sizes.</summary>
        public static readonly int[] PageSizes = { 10, 25, 50, 100, 200, 500 };

        private static readonly Regex LocalDateTime = new(@"^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?)?$", RegexOptions.Compiled);

        /// <summary>The raw value of a query parameter given exactly once, or null.</summary>
        public static string? Raw(this HttpRequest req, string name) =>
            req.Query.TryGetValue(name, out var v) && v.Count == 1 ? v.ToString() : null;

        /// <summary>A query parameter trimmed; null when missing or blank.</summary>
        public static string? Str(this HttpRequest req, string name)
        {
            var v = req.Raw(name)?.Trim();
            return string.IsNullOrEmpty(v) ? null : v;
        }

        /// <summary>A whole-number query parameter; the fallback when missing, not a number, or 0.</summary>
        public static long Int(this HttpRequest req, string name, long fallback)
        {
            var raw = req.Query.TryGetValue(name, out var v) ? v.ToString() : null;
            var n = raw is null ? fallback : Js.ParseInt(raw) ?? 0;
            return n == 0 ? fallback : n;
        }

        /// <summary>?page=, at least 1.</summary>
        public static int Page(this HttpRequest req) => (int)Math.Clamp(Math.Max(1, req.Int("page", 1)), 1, int.MaxValue);

        /// <summary>?pageSize=, one of the allowed sizes (default 50).</summary>
        public static int PageSize(this HttpRequest req)
        {
            var raw = req.Query.TryGetValue("pageSize", out var v) ? v.ToString() : "50";
            var n = Js.ParseInt(raw);
            return n is not null && PageSizes.Contains((int)Math.Clamp(n.Value, 0, 1000)) ? (int)n.Value : 50;
        }

        /// <summary>"db" (this database) or "server" (the whole server).</summary>
        public static string Scope(this HttpRequest req) => req.Raw("scope") == "server" ? "server" : "db";

        /// <summary>True for "YYYY-MM-DD", optionally followed by a time.</summary>
        public static bool IsLocalDateTime(string v) => LocalDateTime.IsMatch(v);

        /// <summary>Reads ?from= and ?to= and checks their format.</summary>
        public static (string? From, string? To) DateRange(this HttpRequest req)
        {
            var from = req.Str("from");
            var to = req.Str("to");
            if (from != null && !IsLocalDateTime(from)) throw new HttpError(400, "Invalid \"from\" date");
            if (to != null && !IsLocalDateTime(to)) throw new HttpError(400, "Invalid \"to\" date");
            return (from, to);
        }
    }
}
