using API.Infrastructure;
using Microsoft.AspNetCore.Mvc.Filters;

namespace API.Filters
{
    /// <summary>
    /// Turns exceptions into the JSON error the UI shows: <c>{ "error": "message" }</c> with the right HTTP status.
    /// </summary>
    public class HttpGlobalExceptionFilter : IAsyncExceptionFilter
    {
        private readonly ILogger<HttpGlobalExceptionFilter> _logger;

        /// <summary>Creates the filter.</summary>
        public HttpGlobalExceptionFilter(ILogger<HttpGlobalExceptionFilter> logger) => _logger = logger;

        /// <summary>Writes the error response.</summary>
        public async Task OnExceptionAsync(ExceptionContext context)
        {
            var response = context.HttpContext.Response;
            var err = context.Exception;
            context.ExceptionHandled = true;

            if (err is CancelledError || (err is OperationCanceledException && context.HttpContext.RequestAborted.IsCancellationRequested))
            {
                // The browser has gone; 499 = client closed the request.
                if (!response.HasStarted) response.StatusCode = 499;
                return;
            }

            var status = err switch
            {
                HttpError http => http.Status,
                ContextError or TargetError => StatusCodes.Status400BadRequest,
                _ => StatusCodes.Status500InternalServerError,
            };
            if (status >= 500) _logger.LogError(err, "[api] {Message}", err.Message);
            if (response.HasStarted) return;
            response.StatusCode = status;
            await response.WriteAsJsonAsync(new { error = string.IsNullOrEmpty(err.Message) ? "Unexpected error" : err.Message });
        }
    }
}
