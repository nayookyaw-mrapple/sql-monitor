using System.Reflection;
using System.Text.Encodings.Web;
using API.Configuration;
using API.Filters;
using API.Infrastructure;
using API.Middleware;
using API.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.FileProviders;
using Microsoft.OpenApi.Models;

namespace API
{
    /// <summary>
    /// Configures the services and the application's request pipeline.
    /// </summary>
    public class Startup
    {
        private const string CorsPolicy = "CorsPolicy";

        /// <summary>
        /// Initializes a new instance of the <see cref="Startup"/> class.
        /// </summary>
        /// <param name="configuration">The configuration.</param>
        public Startup(IConfiguration configuration) => Configuration = configuration;

        /// <summary>
        /// Gets the configuration.
        /// </summary>
        public IConfiguration Configuration { get; }

        /// <summary>
        /// Configures the services used by the application.
        /// </summary>
        /// <param name="services">The service collection.</param>
        public void ConfigureServices(IServiceCollection services)
        {
            services.Configure<ApiBehaviorOptions>(options =>
            {
                options.SuppressModelStateInvalidFilter = true;
            });

            services.AddControllers(options =>
            {
                options.Filters.Add(typeof(HttpGlobalExceptionFilter));
            }).AddJsonOptions(options =>
            {
                // Property names in camelCase; column names of table rows are sent exactly as they are in the database.
                options.JsonSerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase;
                options.JsonSerializerOptions.DictionaryKeyPolicy = null;
                options.JsonSerializerOptions.Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping;
            });

            services.AddCors(options =>
            {
                options.AddPolicy(CorsPolicy, builder =>
                {
                    var corsOrigin = Configuration["CORS_ORIGIN"] ?? "http://localhost:4200";
                    builder
                        .WithOrigins(corsOrigin.Split(',').Select(s => s.Trim()).Where(s => s.Length > 0).ToArray())
                        .WithMethods("GET")
                        .AllowAnyHeader();
                });
            });

            services.AddEndpointsApiExplorer();
            services.AddSwaggerGen(options =>
            {
                options.SwaggerDoc("v1", new OpenApiInfo
                {
                    Title = Program.AppName,
                    Version = "v1"
                });
                var xmlFilename = $"{Assembly.GetExecutingAssembly().GetName().Name}.xml";
                var xmlPath = Path.Combine(AppContext.BaseDirectory, xmlFilename);
                if (File.Exists(xmlPath)) options.IncludeXmlComments(xmlPath);
            });

            // One instance of everything: each service keeps its state per database (see TargetRegistry).
            services.AddSingleton<TargetRegistry>();
            services.AddSingleton<Db>();
            services.AddSingleton<Catalog>();
            services.AddSingleton<ContextService>();
            services.AddSingleton<Discovery>();
            services.AddSingleton<MonitorService>();
            services.AddSingleton<TableSummaries>();
            services.AddSingleton<ErrorService>();
            services.AddSingleton<SqlActivityService>();
            services.AddSingleton<HistoryStore>();
            services.AddSingleton<Sampler>();
            services.AddSingleton<AuditReader>();

            services.AddHostedService<MonitorHostedService>();
        }

        /// <summary>
        /// Configures the HTTP request pipeline.
        /// </summary>
        /// <param name="app">The application builder.</param>
        /// <param name="env">The web host environment.</param>
        /// <param name="lifetime">The application lifetime.</param>
        /// <param name="config">The settings of the monitor.</param>
        /// <param name="logger">The logger.</param>
        public void Configure(IApplicationBuilder app, IWebHostEnvironment env, IHostApplicationLifetime lifetime, MonitorConfig config, ILogger<Startup> logger)
        {
            app.UseCors(CorsPolicy);

            // Read-only service: reject anything that is not a GET/HEAD/OPTIONS.
            app.UseMiddleware<ReadOnlyMiddleware>();

            app.UseSwagger();
            app.UseSwaggerUI();

            // Every API call runs against the database chosen in the header (X-Target).
            app.UseMiddleware<TargetMiddleware>();

            // Serve the built Angular app when present (npm run build in ../client).
            var clientDist = ServerPaths.ClientDist();
            PhysicalFileProvider? clientFiles = null;
            if (clientDist != null)
            {
                clientFiles = new PhysicalFileProvider(clientDist);
                app.UseStaticFiles(new StaticFileOptions { FileProvider = clientFiles });
                logger.LogInformation("[server] serving the UI from {Path}", clientDist);
            }

            app.UseRouting();

            app.UseEndpoints(endpoints =>
            {
                endpoints.MapControllers();

                if (clientFiles != null)
                {
                    // Any other address belongs to the Angular app (its own routing), except unknown /api/ addresses.
                    // "{*path}" (not the default pattern): addresses with a dot, such as /tables/dbo.xyz, are app pages too.
                    endpoints.MapFallback("{*path}", async context =>
                    {
                        if (context.Request.Path.StartsWithSegments("/api"))
                        {
                            context.Response.StatusCode = StatusCodes.Status404NotFound;
                            return;
                        }
                        context.Response.ContentType = "text/html; charset=utf-8";
                        await context.Response.SendFileAsync(clientFiles.GetFileInfo("index.html"));
                    });
                }
            });

            lifetime.ApplicationStarted.Register(() =>
                logger.LogInformation("[server] SQL Monitor API listening on http://localhost:{Port}", config.Port));
        }
    }
}
