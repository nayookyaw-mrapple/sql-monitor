using API.Configuration;
using Serilog;
using Serilog.Events;

namespace API
{
    /// <summary>
    /// Main program class for the SQL Monitor API application.
    /// </summary>
    public class Program
    {
        /// <summary>
        /// Gets the application name.
        /// </summary>
        public static readonly string AppName = "SQL.Monitor.API";

        /// <summary>
        /// Main entry point for the application.
        /// </summary>
        /// <param name="args">Command line arguments.</param>
        /// <returns>The process exit code: 0, or 1 when the server could not start.</returns>
        public static async Task<int> Main(string[] args)
        {
            var configuration = GetConfiguration();

            Log.Logger = CreateSerilogLogger(configuration);

            try
            {
                Log.Information("Configuring web host ({ApplicationContext})...", AppName);
                // Read the settings first, so a missing or wrong one stops the start with a clear message.
                var monitorConfig = new MonitorConfig(configuration);
                var host = CreateHostBuilder(args, configuration, monitorConfig).Build();

                Log.Information("Starting web host ({ApplicationContext})...", AppName);
                await host.RunAsync();

                return 0;
            }
            catch (Exception ex)
            {
                Log.Fatal(ex, "[server] failed to start ({ApplicationContext})", AppName);
                return 1;
            }
            finally
            {
                await Log.CloseAndFlushAsync();
            }
        }

        /// <summary>
        /// Creates and configures the host builder for the application.
        /// </summary>
        /// <param name="args">Command line arguments.</param>
        /// <param name="configuration">The application configuration.</param>
        /// <param name="monitorConfig">The settings of the monitor.</param>
        /// <returns>The configured host builder.</returns>
        public static IHostBuilder CreateHostBuilder(string[] args, IConfiguration configuration, MonitorConfig monitorConfig) =>
            Host.CreateDefaultBuilder(args)
                .ConfigureServices(services => services.AddSingleton(monitorConfig))
                .ConfigureWebHostDefaults(webBuilder =>
                {
                    webBuilder.UseConfiguration(configuration)
                        .CaptureStartupErrors(false)
                        .ConfigureKestrel(options =>
                        {
                            options.AddServerHeader = false;
                            options.ListenAnyIP(monitorConfig.Port);
                        })
                        .UseStartup<Startup>();
                }).UseSerilog();

        private static IConfiguration GetConfiguration()
        {
            var environment = Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT") ?? "Development";

            // appsettings.json sits next to the binaries; the connection settings come from server/.env
            // (the same file the Node.js server used) and real environment variables win over it.
            var builder = new ConfigurationBuilder()
                .SetBasePath(AppContext.BaseDirectory)
                .AddJsonFile("appsettings.json", optional: true, reloadOnChange: false)
                .AddJsonFile($"appsettings.{environment}.json", optional: true, reloadOnChange: false)
                .AddDotEnvFile(ServerPaths.EnvFile)
                .AddEnvironmentVariables();
            return builder.Build();
        }

        private static Serilog.ILogger CreateSerilogLogger(IConfiguration configuration)
        {
            return new LoggerConfiguration()
                .MinimumLevel.Information()
                // Keep the application's own messages, but silence the framework's per-request chatter.
                // Microsoft.Hosting.Lifetime stays at Information so startup/shutdown messages survive.
                .MinimumLevel.Override("Microsoft", LogEventLevel.Warning)
                .MinimumLevel.Override("Microsoft.Hosting.Lifetime", LogEventLevel.Information)
                .MinimumLevel.Override("System", LogEventLevel.Warning)
                .Enrich.WithProperty("ApplicationContext", AppName)
                .Enrich.FromLogContext()
                .WriteTo.Console()
                .ReadFrom.Configuration(configuration)
                .CreateLogger();
        }
    }
}
