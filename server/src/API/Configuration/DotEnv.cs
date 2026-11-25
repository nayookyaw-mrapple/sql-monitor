using System.Text.RegularExpressions;

namespace API.Configuration
{
    /// <summary>
    /// Reads a <c>.env</c> file (KEY=value lines) so the settings file used so far keeps working unchanged.
    /// Real environment variables are added after it and win, as before.
    /// </summary>
    public static class DotEnv
    {
        private static readonly Regex Line = new(
            @"^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)?\s*$",
            RegexOptions.Compiled);

        /// <summary>Parses the file; a missing file gives no settings.</summary>
        public static Dictionary<string, string?> Read(string path)
        {
            var result = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
            if (!File.Exists(path)) return result;

            foreach (var raw in File.ReadAllLines(path))
            {
                var line = raw.Trim();
                if (line.Length == 0 || line[0] == '#') continue;
                var m = Line.Match(line);
                if (!m.Success) continue;
                result[m.Groups[1].Value] = Unquote(m.Groups[2].Value.Trim());
            }
            return result;
        }

        private static string Unquote(string value)
        {
            if (value.Length >= 2)
            {
                var quote = value[0];
                if (quote is '"' or '\'' or '`')
                {
                    var end = value.LastIndexOf(quote);
                    if (end > 0)
                    {
                        var inner = value.Substring(1, end - 1);
                        return quote == '"' ? inner.Replace("\\n", "\n").Replace("\\r", "\r") : inner;
                    }
                }
            }
            // Unquoted: a " #" starts a comment.
            var hash = value.IndexOf(" #", StringComparison.Ordinal);
            if (hash >= 0) value = value.Substring(0, hash);
            return value.Trim();
        }
    }

    /// <summary>Adds a <c>.env</c> file to the configuration.</summary>
    public static class DotEnvConfigurationExtensions
    {
        /// <summary>Adds the settings of a <c>.env</c> file (if it exists).</summary>
        public static IConfigurationBuilder AddDotEnvFile(this IConfigurationBuilder builder, string path) =>
            builder.AddInMemoryCollection(DotEnv.Read(path));
    }
}
