using System.Text.RegularExpressions;

namespace API.Services
{
    /// <summary>
    /// Works out what a SQL Agent job step runs from its command text: the stored procedures it calls and the
    /// files, folders and SSIS packages it names. Best effort: it reads the step's own text only, not what a
    /// procedure or package does once it is running.
    /// </summary>
    public static class JobCommand
    {
        private const string Name = @"(?:\[[^\]]+\]|[A-Za-z_#][\w$#]*)(?:\.(?:\[[^\]]+\]|[A-Za-z_#][\w$#]*)?){0,3}";

        private static readonly Regex LineComment = new(@"--[^\r\n]*", RegexOptions.Compiled);
        private static readonly Regex BlockComment = new(@"/\*.*?\*/", RegexOptions.Compiled | RegexOptions.Singleline);
        private static readonly Regex Exec = new($@"\bEXEC(?:UTE)?\s+(?:@\w+\s*=\s*)?({Name})", RegexOptions.Compiled | RegexOptions.IgnoreCase);
        private static readonly Regex FirstWord = new($@"^({Name})(?=\s|;|$)", RegexOptions.Compiled);
        private static readonly Regex Spaces = new(@"\s+", RegexOptions.Compiled);

        /// <summary>A drive or network path inside double or single quotes (may hold spaces), then one without quotes.</summary>
        private static readonly Regex[] Paths =
        {
            new(@"""((?:[A-Za-z]:\\|\\\\\w)[^""\r\n]+)""", RegexOptions.Compiled),
            new(@"'((?:[A-Za-z]:\\|\\\\\w)[^'\r\n]+)'", RegexOptions.Compiled),
            new(@"(?<![\w""'\\])((?:[A-Za-z]:\\|\\\\\w)[^\s""'<>|*?;,]*)", RegexOptions.Compiled),
            new(@"(\\SSISDB\\[^""\r\n]+?\.dtsx)", RegexOptions.Compiled | RegexOptions.IgnoreCase),
        };

        /// <summary>Words that start a statement, so a command beginning with one is not a bare procedure call.</summary>
        private static readonly HashSet<string> Keywords = new(StringComparer.OrdinalIgnoreCase)
        {
            "SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "DECLARE", "SET", "IF", "ELSE", "BEGIN", "END", "WHILE",
            "EXEC", "EXECUTE", "USE", "WITH", "RAISERROR", "PRINT", "WAITFOR", "DBCC", "BACKUP", "RESTORE", "ALTER", "CREATE",
            "DROP", "GO", "THROW", "RETURN", "GRANT", "REVOKE", "DENY", "OPEN", "CLOSE", "FETCH", "DEALLOCATE", "COMMIT",
            "ROLLBACK", "SAVE", "KILL", "CHECKPOINT", "BULK", "AS", "LOGIN", "USER", "GOTO", "BREAK", "CONTINUE", "TRY",
        };

        private const int MaxItems = 25;

        /// <summary>The Agent subsystem of a step in plain words.</summary>
        public static string Kind(string? subsystem) => (subsystem ?? "").ToUpperInvariant() switch
        {
            "TSQL" => "T-SQL",
            "SSIS" => "SSIS package",
            "CMDEXEC" => "Command line",
            "POWERSHELL" => "PowerShell",
            "LOGREADER" => "Replication log reader",
            "DISTRIBUTION" => "Replication distribution",
            "SNAPSHOT" => "Replication snapshot",
            "MERGE" => "Replication merge",
            "QUEUEREADER" => "Replication queue reader",
            "ANALYSISCOMMAND" or "ANALYSISQUERY" => "Analysis Services",
            "" => "Unknown",
            _ => subsystem!,
        };

        /// <summary>Stored procedures a T-SQL step calls, in the order they appear.</summary>
        public static List<string> Procedures(string? subsystem, string? command)
        {
            var found = new List<string>();
            if (string.IsNullOrWhiteSpace(command) || !string.Equals(subsystem, "TSQL", StringComparison.OrdinalIgnoreCase)) return found;
            var text = LineComment.Replace(BlockComment.Replace(command, " "), " ").Trim();

            void Add(string name)
            {
                name = name.TrimEnd('.');
                if (name.Length == 0 || Keywords.Contains(name)) return;
                if (found.Count < MaxItems && !found.Contains(name, StringComparer.OrdinalIgnoreCase)) found.Add(name);
            }

            // "dbo.MyProc @x = 1" with no EXEC is a valid batch when the call comes first.
            var first = FirstWord.Match(text);
            if (first.Success) Add(first.Groups[1].Value);
            foreach (Match m in Exec.Matches(text)) Add(m.Groups[1].Value);
            return found;
        }

        /// <summary>Files, folders and SSIS packages named in a step's command, in the order they appear.</summary>
        public static List<string> Files(string? command)
        {
            var found = new List<string>();
            if (string.IsNullOrWhiteSpace(command)) return found;
            foreach (var pattern in Paths)
            {
                foreach (Match m in pattern.Matches(command))
                {
                    var path = m.Groups[1].Value.Trim().TrimEnd('\\', '.', ')', ']');
                    if (path.Length < 4) continue;
                    // The quoted and unquoted patterns can both see the same path; keep the longest form.
                    if (found.Any(f => f.StartsWith(path, StringComparison.OrdinalIgnoreCase))) continue;
                    if (found.Count < MaxItems) found.Add(path);
                }
            }
            return found;
        }

        /// <summary>The command on one line, shortened.</summary>
        public static string? Preview(string? command, int max)
        {
            if (string.IsNullOrWhiteSpace(command)) return null;
            var line = Spaces.Replace(command, " ").Trim();
            return line.Length <= max ? line : line.Substring(0, max) + "…";
        }
    }
}
