namespace API.Configuration
{
    /// <summary>
    /// Where the server keeps its files. The "server folder" is the one holding <c>.env</c> (or
    /// <c>SqlMonitor.sln</c>): relative paths such as <c>data/history.db</c> are resolved from it, and the built
    /// Angular app is looked for next to it in <c>../client/dist/client/browser</c>.
    /// </summary>
    public static class ServerPaths
    {
        private static readonly Lazy<string> RootDir = new(FindRoot);

        /// <summary>The server folder (set SQLMONITOR_ROOT to choose it explicitly).</summary>
        public static string Root => RootDir.Value;

        /// <summary>The <c>.env</c> file with the connection settings.</summary>
        public static string EnvFile => Path.Combine(Root, ".env");

        /// <summary>Folder of the built Angular app, or null when it has not been built.</summary>
        public static string? ClientDist()
        {
            var candidates = new[]
            {
                Path.Combine(AppContext.BaseDirectory, "wwwroot"),
                Path.Combine(Root, "wwwroot"),
                Path.GetFullPath(Path.Combine(Root, "..", "client", "dist", "client", "browser")),
            };
            return candidates.FirstOrDefault(d => File.Exists(Path.Combine(d, "index.html")));
        }

        private static string FindRoot()
        {
            var explicitRoot = Environment.GetEnvironmentVariable("SQLMONITOR_ROOT");
            if (!string.IsNullOrWhiteSpace(explicitRoot)) return Path.GetFullPath(explicitRoot);

            foreach (var start in new[] { AppContext.BaseDirectory, Directory.GetCurrentDirectory() })
            {
                for (var dir = new DirectoryInfo(start); dir != null; dir = dir.Parent)
                {
                    if (File.Exists(Path.Combine(dir.FullName, ".env")) || File.Exists(Path.Combine(dir.FullName, "SqlMonitor.sln")))
                        return dir.FullName;
                }
            }
            return Directory.GetCurrentDirectory();
        }
    }
}
