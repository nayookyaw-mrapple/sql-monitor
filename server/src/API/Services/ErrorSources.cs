using API.Infrastructure;

namespace API.Services
{
    /// <summary>
    /// A place in the database where errors are recorded. Every source is mapped onto the same
    /// row shape so the UI can show one merged, time-ordered feed. All SQL fragments below are
    /// fixed (never built from user input); user values are bound as parameters.
    /// </summary>
    public sealed class ErrorSource
    {
        /// <summary>Source id used by the API.</summary>
        public required string Id { get; init; }

        /// <summary>Name shown in the UI.</summary>
        public required string Label { get; init; }

        /// <summary>SQL Server, Application, Integration or Business.</summary>
        public required string Category { get; init; }

        /// <summary>What the source holds.</summary>
        public required string Description { get; init; }

        /// <summary>Real table the error row lives in (shown in the UI so users can trace it back).</summary>
        public required string TableName { get; init; }

        /// <summary>SQL expression producing the WHERE predicate that selects this exact row, e.g. 'ApplErrorID = 123'.</summary>
        public required string Key { get; init; }

        /// <summary>Database the source is read from.</summary>
        public PoolName Pool { get; init; } = PoolName.Main;

        /// <summary>Rows depend on the selected Site/Season (row-level security): none, season, season_site or server.</summary>
        public required string Rls { get; init; }

        /// <summary>FROM clause.</summary>
        public required string From { get; init; }

        /// <summary>Fixed WHERE predicate, if any.</summary>
        public string? Where { get; init; }

        /// <summary>SQL expression of the row id.</summary>
        public required string IdExpr { get; init; }

        /// <summary>SQL expression of the error time.</summary>
        public required string Time { get; init; }

        /// <summary>SQL expression of where the error came from.</summary>
        public required string Origin { get; init; }

        /// <summary>SQL expression of the error code.</summary>
        public required string Code { get; init; }

        /// <summary>SQL expression of the message.</summary>
        public required string Message { get; init; }

        /// <summary>SQL expression of the user.</summary>
        public required string User { get; init; }

        /// <summary>SQL expression of the severity (error, warning, info).</summary>
        public required string Severity { get; init; }

        /// <summary>Extra fields shown in the detail panel: label and SQL expression, in display order.</summary>
        public required (string Label, string Expr)[] Extra { get; init; }

        private const string AgentTime =
            "CONVERT(datetime, CONVERT(char(8), h.run_date)) + CAST(STUFF(STUFF(RIGHT('000000' + CAST(h.run_time AS varchar(6)), 6), 5, 0, ':'), 3, 0, ':') AS datetime)";

        /// <summary>Every error source, in display order. To add one, append an entry.</summary>
        public static readonly IReadOnlyList<ErrorSource> All = new List<ErrorSource>
        {
            new()
            {
                Id = "agent",
                Label = "SQL Agent job failures",
                Category = "SQL Server",
                Description = "Failed, retried and cancelled SQL Server Agent job steps (msdb.dbo.sysjobhistory), e.g. sqlXMLLoad queue jobs.",
                TableName = "msdb.dbo.sysjobhistory",
                Key = "'instance_id = ' + CAST(h.instance_id AS varchar(12))",
                Pool = PoolName.Msdb,
                Rls = "server",
                From = "msdb.dbo.sysjobhistory h JOIN msdb.dbo.sysjobs j ON j.job_id = h.job_id LEFT JOIN msdb.dbo.sysjobsteps s ON s.job_id = h.job_id AND s.step_id = h.step_id",
                Where = "h.step_id > 0 AND h.run_status IN (0, 2, 3)",
                IdExpr = "h.instance_id",
                Time = AgentTime,
                Origin = "j.name",
                Code = "CASE h.run_status WHEN 0 THEN 'Failed' WHEN 2 THEN 'Retry' WHEN 3 THEN 'Cancelled' END + CASE WHEN h.sql_message_id > 0 THEN ' · Msg ' + CAST(h.sql_message_id AS varchar(12)) ELSE '' END",
                Message = "h.message",
                User = "CAST(NULL AS varchar(1))",
                Severity = "CASE WHEN h.run_status = 0 THEN 'error' ELSE 'warning' END",
                Extra = new[]
                {
                    ("Step", "CAST(h.step_id AS varchar(10)) + ' · ' + h.step_name"),
                    ("Step database", "s.database_name"),
                    ("Step command", "LEFT(s.command, 4000)"),
                    ("Duration (hhmmss)", "h.run_duration"),
                    ("SQL severity", "h.sql_severity"),
                    ("Server", "h.server"),
                    ("Retries attempted", "h.retries_attempted"),
                },
            },
            new()
            {
                Id = "app",
                Label = "Application errors",
                Category = "Application",
                Description = "Errors logged by Mr Apple desktop/service applications (ma_ApplicationErrorT).",
                TableName = "dbo.ma_ApplicationErrorT",
                Key = "'ApplErrorID = ' + CAST(e.ApplErrorID AS varchar(12))",
                Rls = "none",
                From = "dbo.ma_ApplicationErrorT e",
                IdExpr = "e.ApplErrorID",
                Time = "e.ErrorDateTime",
                Origin = "e.Application",
                Code = "CAST(e.ErrorNo AS varchar(20))",
                Message = "e.ErrorDesc",
                User = "e.UserLogon",
                Severity = "'error'",
                Extra = new[] { ("Version", "e.Version"), ("Form", "e.FormName"), ("Function", "e.FunctionName"), ("SiteID", "e.SiteID"), ("Season", "e.Season") },
            },
            new()
            {
                Id = "pk_app",
                Label = "Packaging app errors",
                Category = "Application",
                Description = "Errors logged by the Mr Apple Packaging application (pk_App_Error_LogT).",
                TableName = "dbo.pk_App_Error_LogT",
                Key = "'AppErrorLogID = ' + CAST(e.AppErrorLogID AS varchar(12))",
                Rls = "none",
                From = "dbo.pk_App_Error_LogT e",
                IdExpr = "e.AppErrorLogID",
                Time = "e.ErrorDateTime",
                Origin = "e.AppName",
                Code = "e.ErrorNo",
                Message = "e.ErrorDesc",
                User = "e.UserName",
                Severity = "CASE WHEN e.ErrorDesc LIKE 'Application Started%' THEN 'info' ELSE 'error' END",
                Extra = new[] { ("Version", "e.VersionNo"), ("Host", "e.HostName"), ("Form", "e.FormName"), ("Function", "e.FunctionName") },
            },
            new()
            {
                Id = "nav",
                Label = "NAV transmission errors",
                Category = "Integration",
                Description = "XML transmissions to NAV that came back with status E (xml_NAV_TransmissionT).",
                TableName = "dbo.xml_NAV_TransmissionT",
                Key = "'xmlNAVTransmissionID = ' + CAST(n.xmlNAVTransmissionID AS varchar(12))",
                Rls = "season",
                From = "dbo.xml_NAV_TransmissionT n",
                Where = "n.TransmissionStatus = 'E'",
                IdExpr = "n.xmlNAVTransmissionID",
                Time = "COALESCE(n.ResponseDateTime, n.SentDateTime, n.CreatedDateTime)",
                Origin = "n.xmlNAVTransmissionType + ISNULL(' · ' + n.TransmissionAction, '')",
                Code = "'Status E'",
                Message = "ISNULL(n.TransmissionStatusDetail, ISNULL(n.Note, ''))",
                User = "n.CreatedByUserName",
                Severity = "'error'",
                Extra = new[]
                {
                    ("Transfer no", "n.TransferNo"),
                    ("Run no", "n.RunNo"),
                    ("Batch no", "n.BatchNo"),
                    ("Purchase order", "n.PurchaseOrderID"),
                    ("Load in", "n.LoadInID"),
                    ("Sent at", "n.SentDateTime"),
                    ("Response at", "n.ResponseDateTime"),
                    ("Retries", "n.SentNoOfRetries"),
                    ("Note", "n.Note"),
                    ("Season", "n.Season"),
                },
            },
            new()
            {
                Id = "xml_load",
                Label = "XML load validation errors",
                Category = "Integration",
                Description = "Validation failures when loading supplier XML transactions (pk_xml_Load_Transaction_ErrorT).",
                TableName = "dbo.pk_xml_Load_Transaction_ErrorT",
                Key = "'XMLTransErrorID = ' + CAST(x.XMLTransErrorID AS varchar(12))",
                Rls = "none",
                From = "dbo.pk_xml_Load_Transaction_ErrorT x",
                IdExpr = "x.XMLTransErrorID",
                Time = "x.CreatedDateTime",
                Origin = "'XML trans ' + CAST(x.XMLTransID AS varchar(12))",
                Code = "CAST(NULL AS varchar(1))",
                Message = "x.ValidationErrorMsg",
                User = "x.CreatedByUserName",
                Severity = "'error'",
                Extra = new[] { ("XML trans id", "x.XMLTransID") },
            },
            new()
            {
                Id = "xml_monitor",
                Label = "XML monitor errors",
                Category = "Integration",
                Description = "Errors raised by the XML monitor (xml_Monitor_ErrorT).",
                TableName = "dbo.xml_Monitor_ErrorT",
                Key = "'xmlErrorID = ' + CAST(m.xmlErrorID AS varchar(12))",
                Rls = "season",
                From = "dbo.xml_Monitor_ErrorT m",
                IdExpr = "m.xmlErrorID",
                Time = "COALESCE(m.ErrorDateTime, m.CreatedDateTime)",
                Origin = "'xmlID ' + CAST(m.xmlID AS varchar(12))",
                Code = "CAST(NULL AS varchar(1))",
                Message = "CAST(m.Description AS varchar(max))",
                User = "m.CreatedByUserName",
                Severity = "'error'",
                Extra = new[] { ("xml id", "m.xmlID"), ("Resolution", "m.Resolution"), ("Contact", "m.Contact"), ("Season", "m.Season") },
            },
            new()
            {
                Id = "pallet",
                Label = "Pallet errors",
                Category = "Business",
                Description = "Pallet processing errors (ma_Pallet_ErrorT).",
                TableName = "dbo.ma_Pallet_ErrorT",
                Key = "'PalletID = ' + CAST(p.PalletID AS varchar(12))",
                Rls = "season_site",
                From = "dbo.ma_Pallet_ErrorT p",
                IdExpr = "p.PalletID",
                Time = "p.CreatedDateTime",
                Origin = "'Pallet ' + CAST(p.PalletID AS varchar(12))",
                Code = "CAST(NULL AS varchar(1))",
                Message = "p.ErrorMsg",
                User = "p.CreatedByUserName",
                Severity = "'error'",
                Extra = new[] { ("Pallet id", "p.PalletID"), ("SiteID", "p.SiteID"), ("Season", "p.Season") },
            },
            new()
            {
                Id = "pp_run",
                Label = "Production run errors",
                Category = "Business",
                Description = "Production runs with an error description (pp_RunT.ErrorDesc).",
                TableName = "dbo.pp_RunT",
                Key = "'RunRecordID = ' + CAST(r.RunRecordID AS varchar(12))",
                Rls = "season",
                From = "dbo.pp_RunT r",
                Where = "r.ErrorDesc IS NOT NULL AND r.ErrorDesc <> ''",
                IdExpr = "r.RunRecordID",
                Time = "r.CreatedDateTime",
                Origin = "'Run ' + CAST(r.RunNo AS varchar(12)) + ISNULL(' · ' + r.SLoc, '')",
                Code = "CAST(NULL AS varchar(1))",
                Message = "r.ErrorDesc",
                User = "r.CreatedByUserName",
                Severity = "'error'",
                Extra = new[] { ("RPin", "r.RPin"), ("Variety", "r.Variety"), ("Pack date", "r.PackDate"), ("Season", "r.Season") },
            },
            new()
            {
                Id = "hq_exception",
                Label = "HQ exceptions",
                Category = "Business",
                Description = "Business exceptions raised by HQ processes, e.g. stock balance checks (hq_ExceptionT).",
                TableName = "dbo.hq_ExceptionT",
                Key = "'ExceptionID = ' + CAST(x.ExceptionID AS varchar(12))",
                Rls = "season",
                From = "dbo.hq_ExceptionT x",
                IdExpr = "x.ExceptionID",
                Time = "x.CreatedDateTime",
                Origin = "x.ExceptionType",
                Code = "CAST(NULL AS varchar(1))",
                Message = "x.ExceptionMsg",
                User = "x.CreatedByUserName",
                Severity = "'warning'",
                Extra = new[] { ("Exception date", "x.ExceptionDate"), ("Exception time", "x.ExceptionTime"), ("Season", "x.Season") },
            },
            new()
            {
                Id = "edi",
                Label = "EDI delivery failures",
                Category = "Integration",
                Description = "EDI messages to partners whose delivery recorded an error (edi_DeliveryT.LastError). Times converted to NZ local time.",
                TableName = "dbo.edi_DeliveryT",
                Key = "'DeliveryID = ''' + CAST(d.DeliveryID AS varchar(36)) + ''''",
                Rls = "none",
                From = "dbo.edi_DeliveryT d",
                Where = "d.LastError IS NOT NULL AND d.LastError <> ''",
                IdExpr = "CAST(d.DeliveryID AS varchar(36))",
                Time = "COALESCE(CAST(SWITCHOFFSET(d.CompletedAt, DATEPART(TZOFFSET, SYSDATETIMEOFFSET())) AS datetime2(3)), CAST(SWITCHOFFSET(d.CreatedAt, DATEPART(TZOFFSET, SYSDATETIMEOFFSET())) AS datetime2(3)))",
                Origin = "d.Partner + ' · ' + d.MessageType",
                Code = "d.Status",
                Message = "d.LastError",
                User = "d.RequestedBy",
                Severity = "'error'",
                Extra = new[]
                {
                    ("Business key", "d.BusinessKey"),
                    ("Attempts", "d.AttemptCount"),
                    ("Partner reference", "d.PartnerReference"),
                    ("Source subject", "d.SourceSubject"),
                    ("Request id", "d.RequestID"),
                    ("SiteID", "d.SiteID"),
                    ("Season", "d.Season"),
                },
            },
            new()
            {
                Id = "caspa_outbox",
                Label = "Caspa event outbox failures",
                Category = "Integration",
                Description = "Caspa events that failed to dispatch or were dead-lettered (Caspa_EventOutbox). Times shown as stored.",
                TableName = "dbo.Caspa_EventOutbox",
                Key = "'id = ' + CAST(o.id AS varchar(20))",
                Rls = "none",
                From = "dbo.Caspa_EventOutbox o",
                Where = "(o.lastError IS NOT NULL AND o.lastError <> '') OR o.deadLetteredAt IS NOT NULL",
                IdExpr = "o.id",
                Time = "COALESCE(o.deadLetteredAt, o.dispatchedAt, o.createdAt)",
                Origin = "o.subject",
                Code = "CASE WHEN o.deadLetteredAt IS NOT NULL THEN 'Dead-lettered' ELSE 'Retrying' END",
                Message = "ISNULL(o.lastError, '')",
                User = "CAST(NULL AS varchar(1))",
                Severity = "CASE WHEN o.deadLetteredAt IS NOT NULL THEN 'error' ELSE 'warning' END",
                Extra = new[] { ("Event id", "o.eventId"), ("Attempts", "o.attemptCount"), ("Created at", "o.createdAt"), ("Correlation id", "o.correlationId") },
            },
            new()
            {
                Id = "usda",
                Label = "USDA lot failures",
                Category = "Business",
                Description = "USDA inspection lots with a fail reason (sw_USDA_LotNoT.FailReason).",
                TableName = "dbo.sw_USDA_LotNoT",
                Key = "'USDALotNo = ''' + u.USDALotNo + ''''",
                Rls = "season",
                From = "dbo.sw_USDA_LotNoT u",
                Where = "u.FailReason IS NOT NULL AND u.FailReason <> ''",
                IdExpr = "u.USDALotNo",
                Time = "COALESCE(u.InspectDate, u.CreatedDateTime)",
                Origin = "'Lot ' + u.USDALotNo + ISNULL(' · ' + u.PackhouseSLoc, '')",
                Code = "u.Status",
                Message = "u.FailReason",
                User = "u.CreatedByUserName",
                Severity = "'error'",
                Extra = new[] { ("Coolstore SLoc", "u.CoolstoreSLoc"), ("Pallets", "u.NoOfPallets"), ("Samples", "u.NoOfSamples"), ("Comment", "u.Comment"), ("Season", "u.Season") },
            },
        };
    }
}
