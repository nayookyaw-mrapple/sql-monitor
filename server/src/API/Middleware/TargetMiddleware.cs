using API.Infrastructure;
using API.Services;

namespace API.Middleware
{
    /// <summary>
    /// Every API call runs against the database chosen in the header (X-Target), starting its monitoring on first use.
    /// </summary>
    public class TargetMiddleware
    {
        private readonly RequestDelegate _next;

        /// <summary>Creates the middleware.</summary>
        public TargetMiddleware(RequestDelegate next) => _next = next;

        /// <summary>Resolves the database of an /api request and makes it the current one for the rest of the request.</summary>
        public async Task InvokeAsync(HttpContext context, TargetRegistry targets, MonitorService monitor, Discovery discovery)
        {
            if (!context.Request.Path.StartsWithSegments("/api", out var rest))
            {
                await _next(context);
                return;
            }

            // The databases are searched for once at start; requests arriving before that has finished wait for it.
            await discovery.Ready;

            // Listing the databases must not start monitoring one.
            if (rest.Value is "/targets" or "/targets/")
            {
                await _next(context);
                return;
            }

            try
            {
                var target = targets.From(context.Request);
                await monitor.EnsureTargetAsync(target);
                targets.Enter(target);
            }
            catch (Exception err)
            {
                context.Response.StatusCode = err is TargetError ? StatusCodes.Status400BadRequest : StatusCodes.Status502BadGateway;
                await context.Response.WriteAsJsonAsync(new { error = $"Cannot open database: {err.Message}" });
                return;
            }
            await _next(context);
        }
    }
}
