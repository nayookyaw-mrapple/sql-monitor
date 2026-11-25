using API.Configuration;
using API.Services;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace API.Tests
{
    /// <summary>The local SQLite history, on a throw-away file.</summary>
    public sealed class HistoryStoreTests : IDisposable
    {
        private readonly string _dir = Path.Combine(Path.GetTempPath(), "sqlmonitor-tests-" + Guid.NewGuid().ToString("N"));
        private readonly string _path;
        private readonly HistoryStore _store;

        public HistoryStoreTests()
        {
            _path = Path.Combine(_dir, "history.db");
            var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["DB_AUTH"] = "windows",
                ["DB_SERVERS"] = "SRV",
                ["HISTORY_DB_PATH"] = _path,
            }).Build();
            _store = new HistoryStore(new MonitorConfig(configuration));
        }

        public void Dispose()
        {
            _store.Dispose();
            SqliteConnection.ClearAllPools();
            try
            {
                Directory.Delete(_dir, recursive: true);
            }
            catch (IOException)
            {
                // left for the temp folder clean-up
            }
        }

        private static AuditRow Insert() => new()
        {
            EventUtc = "2026-11-25T10:11:12.1234567",
            EventTime = "2026-11-25 23:11:12.123",
            Sequence = 1,
            ActionId = "IN",
            Action = "INSERT",
            Succeeded = true,
            SessionId = 77,
            Db = "MrApple",
            SchemaName = "dbo",
            ObjectName = "ma_PalletT",
            ClassType = "U",
            LoginName = @"MRA\Jane.Doe",
            SessionLogin = @"MRA\Jane.Doe",
            DbUser = "dbo",
            HostName = "PC-01",
            ClientIp = "10.0.0.5",
            ProgramName = "SiteID=2&App=CARLA",
            Statement = "INSERT INTO dbo.ma_PalletT (a) VALUES (@p0) -- ünïcödé ✓",
        };

        private static AuditRow AgentExecute() => new()
        {
            EventUtc = "2026-11-25T10:11:13.0000000",
            EventTime = "2026-11-25 23:11:13.000",
            Sequence = 0,
            ActionId = "EX",
            Action = "EXECUTE",
            Succeeded = false,
            LoginName = @"NT SERVICE\SQLSERVERAGENT",
        };

        private static HistoryFilter Filter(string? db = null, string? search = null, string? whoType = null, string? login = null, string? notLogin = null, string? app = null) =>
            new() { Server = "SRV", Db = db, Search = search, WhoType = whoType, Login = login, NotLogin = notLogin, App = app, Page = 1, PageSize = 50 };

        [Fact]
        public void Audit_records_read_twice_are_saved_once()
        {
            Assert.Equal(2, _store.SaveAuditEvents("SRV", new[] { Insert(), AgentExecute() }));
            Assert.Equal(0, _store.SaveAuditEvents("SRV", new[] { Insert(), AgentExecute() }));
            Assert.Equal(2, _store.QueryAudit(Filter()).Total);
        }

        [Fact]
        public void Audit_records_are_identified_the_same_way_as_by_the_node_server()
        {
            // These two values were written by the Node.js server for the same records. If they change, records
            // already in an existing history.db would be saved a second time.
            _store.SaveAuditEvents("SRV", new[] { Insert(), AgentExecute() });
            _store.Dispose();
            using var connection = new SqliteConnection($"Data Source={_path};Pooling=false");
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT hex(dedupe) FROM audit_event ORDER BY id";
            using var reader = command.ExecuteReader();
            var hashes = new List<string>();
            while (reader.Read()) hashes.Add(reader.GetString(0));
            Assert.Equal(new[] { "C300C5F0CA7341665114315B72319D1120E1FE9B", "3A08A60684F3AFA7693FA87CD61D730F9EAF8A47" }, hashes);
        }

        [Fact]
        public void Audit_filters_find_the_right_rows()
        {
            _store.SaveAuditEvents("SRV", new[] { Insert(), AgentExecute() });

            var all = _store.QueryAudit(Filter());
            Assert.Equal("EXECUTE", all.Rows[0]["action"]); // newest first
            Assert.Equal(false, all.Rows[0]["succeeded"]);
            Assert.Equal(true, all.Rows[1]["succeeded"]);
            Assert.Equal("CARLA", all.Rows[1]["app"]);
            Assert.Equal("SQL Agent", all.Rows[0]["app"]);

            Assert.Equal(1, _store.QueryAudit(Filter(db: "MRAPPLE")).Total);
            Assert.Equal(1, _store.QueryAudit(Filter(whoType: "agent")).Total);
            Assert.Equal(1, _store.QueryAudit(Filter(whoType: "user")).Total);
            Assert.Equal(0, _store.QueryAudit(Filter(whoType: "maui")).Total);
            Assert.Equal(1, _store.QueryAudit(Filter(login: @"mra\jane.doe")).Total);
            Assert.Equal(1, _store.QueryAudit(Filter(notLogin: @"MRA\JANE.DOE")).Total);
            Assert.Equal(1, _store.QueryAudit(Filter(app: "carla")).Total);
            Assert.Equal(1, _store.QueryAudit(Filter(search: "pallet")).Total);
            Assert.Equal(0, _store.QueryAudit(Filter(search: "100%")).Total); // % is a literal, not a wildcard
        }

        [Fact]
        public void A_statement_seen_again_updates_its_row()
        {
            SampleRow Seen(string at, long elapsed) => new()
            {
                Key = "SRV|55|2026-11-25 10:00:00.000|dbo.p|12",
                Capture = "running",
                SeenAt = at,
                Db = "MrApple",
                SessionId = 55,
                RequestStart = "2026-11-25 10:00:00.000",
                Action = "UPDATE",
                Command = "UPDATE",
                ProcName = "dbo.p",
                Statement = "UPDATE t SET a=1",
                Tables = "t",
                LoginName = @"MRA\John",
                HostName = "PC",
                ProgramName = "SSMS",
                ElapsedMs = elapsed,
            };
            _store.SaveSamples("SRV", new[] { Seen("2026-11-25 10:00:05.000", 5000) });
            _store.SaveSamples("SRV", new[] { Seen("2026-11-25 10:00:10.000", 10000) });

            var page = _store.QuerySampled(Filter());
            var row = Assert.Single(page.Rows);
            Assert.Equal(2L, row["samples"]);
            Assert.Equal("2026-11-25 10:00:05.000", row["firstSeen"]);
            Assert.Equal("2026-11-25 10:00:10.000", row["lastSeen"]);
            Assert.Equal(10000L, row["elapsedMs"]);
            Assert.Equal("SSMS", row["app"]);
        }

        [Fact]
        public void The_audit_position_is_remembered_per_server()
        {
            Assert.Equal((null, null), _store.GetAuditPosition("SRV"));
            _store.SetAuditPosition("SRV", @"D:\a\f1.sqlaudit", "123456789012");
            _store.SetAuditPosition("SRV", @"D:\a\f2.sqlaudit", "5");
            Assert.Equal((@"D:\a\f2.sqlaudit", "5"), _store.GetAuditPosition("SRV"));
            Assert.Equal((null, null), _store.GetAuditPosition("OTHER"));
        }
    }
}
