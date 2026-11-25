namespace API.Middleware
{
    /// <summary>Read-only service: reject anything that is not a GET/HEAD/OPTIONS.</summary>
    public class ReadOnlyMiddleware
    {
        private readonly RequestDelegate _next;

        /// <summary>Creates the middleware.</summary>
        public ReadOnlyMiddleware(RequestDelegate next) => _next = next;

        /// <summary>Lets read requests through and answers 405 to everything else.</summary>
        public async Task InvokeAsync(HttpContext context)
        {
            var method = context.Request.Method;
            if (HttpMethods.IsGet(method) || HttpMethods.IsHead(method) || HttpMethods.IsOptions(method))
            {
                await _next(context);
                return;
            }
            context.Response.StatusCode = StatusCodes.Status405MethodNotAllowed;
            await context.Response.WriteAsJsonAsync(new { error = "This service is read-only" });
        }
    }
}
