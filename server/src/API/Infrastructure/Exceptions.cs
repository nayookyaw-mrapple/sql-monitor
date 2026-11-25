namespace API.Infrastructure
{
    /// <summary>An error with the HTTP status to answer with (bad input, unknown table, …).</summary>
    public class HttpError : Exception
    {
        /// <summary>Creates the error.</summary>
        public HttpError(int status, string message) : base(message) => Status = status;

        /// <summary>HTTP status code.</summary>
        public int Status { get; }
    }

    /// <summary>The requested database is unknown or none is available.</summary>
    public class TargetError : Exception
    {
        /// <summary>Creates the error.</summary>
        public TargetError(string message) : base(message) { }
    }

    /// <summary>The requested Site/Season is not valid.</summary>
    public class ContextError : Exception
    {
        /// <summary>Creates the error.</summary>
        public ContextError(string message) : base(message) { }
    }

    /// <summary>The browser went away (or pressed Cancel) and the SQL query was cancelled.</summary>
    public class CancelledError : Exception
    {
        /// <summary>Creates the error.</summary>
        public CancelledError() : base("Query cancelled") { }
    }
}
