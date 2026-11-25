using API.Infrastructure;
using API.Services;
using Xunit;

namespace API.Tests
{
    /// <summary>
    /// The expected values here were produced by the original Node.js implementation, so these tests pin the
    /// behaviour the history already on disk was written with.
    /// </summary>
    public class TextParsingTests
    {
        [Theory]
        [InlineData("select 1", "SELECT", null)]
        [InlineData("SELECT 'DELETE FROM x' AS t -- UPDATE y", "SELECT", null)]
        [InlineData("/* INSERT */ SELECT * FROM a JOIN [dbo].[b] bb ON 1=1", "SELECT", "a")]
        [InlineData("UPDATE STATISTICS dbo.t", "OTHER", null)]
        [InlineData("exec dbo.p @a=1", "EXECUTE", null)]
        [InlineData("CREATE TABLE #t (a int); INSERT #t VALUES (1)", "INSERT", "#t")]
        [InlineData("TRUNCATE TABLE [dbo].[x y]", "TRUNCATE", "dbo.x y")]
        [InlineData("MERGE INTO dbo.t AS tgt USING dbo.s AS src ON 1=1 WHEN MATCHED THEN UPDATE SET a=1;", "MERGE", "dbo.t, dbo.s")]
        [InlineData("SELECT * INTO #tmp FROM dbo.a a1 CROSS APPLY dbo.fn(a1.id) f", "SELECT", "#tmp, dbo.a, dbo.fn")]
        [InlineData("UPDATE hm SET x = 1 FROM ma_Heatmap_BinT hm JOIN  db . dbo . [Other Table]  o ON o.id = hm.id", "UPDATE", "ma_Heatmap_BinT, db.dbo.Other Table")]
        [InlineData("DROP INDEX ix ON t", "DDL", null)]
        [InlineData("", "OTHER", null)]
        [InlineData("WAITFOR DELAY '0:0:5'", "OTHER", null)]
        [InlineData("SELECT TOP 5 * FROM (SELECT 1 a) x", "SELECT", null)]
        [InlineData("DELETE TOP (10) FROM dbo.q WITH (READPAST)", "DELETE", "dbo.q")]
        [InlineData(
            "insert into a select * from b; insert into c select * from d join e on 1=1 join f on 1=1 join g on 1=1 join h on 1=1 join i on 1=1 join j on 1=1 join k on 1=1 join l on 1=1 join m on 1=1 join n on 1=1 join o on 1=1 join p on 1=1",
            "INSERT",
            "a, c, b, d, f, g, h, i, j, k, l, m")]
        public void Batch_text_gives_action_and_tables(string sql, string action, string? tables)
        {
            Assert.Equal(action, Sampler.ActionOfText(sql));
            Assert.Equal(tables, Sampler.TablesIn(sql));
        }

        [Theory]
        [InlineData("INSERT", "INSERT")]
        [InlineData("BULK INSERT", "INSERT")]
        [InlineData("SELECT INTO", "INSERT")]
        [InlineData("update", "UPDATE")]
        [InlineData("DELETE", "DELETE")]
        [InlineData("MERGE", "MERGE")]
        [InlineData("SELECT", "SELECT")]
        [InlineData("EXECUTE", "EXECUTE")]
        [InlineData("TRUNCATE TABLE", "TRUNCATE")]
        [InlineData("CREATE INDEX", "DDL")]
        [InlineData("ALTER TABLE", "DDL")]
        [InlineData("DROP TABLE", "DDL")]
        [InlineData("DBCC", "OTHER")]
        [InlineData("BACKUP DATABASE", "OTHER")]
        [InlineData("", "OTHER")]
        [InlineData(null, "OTHER")]
        [InlineData("AWAITING COMMAND", "OTHER")]
        public void Command_name_gives_action(string? command, string action) => Assert.Equal(action, Sampler.ActionOf(command));

        [Theory]
        [InlineData("SiteID=2&App=CARLA", "PC1", "x", "CARLA")]
        [InlineData("siteId=3&season=2026", null, null, null)]
        [InlineData("SiteID=6", "h", "l", null)]
        [InlineData("x", "transfer-api-58b56785cc-hn82t", "maui", "transfer-api")]
        [InlineData(null, null, @"NT SERVICE\SQLSERVERAGENT", "SQL Agent")]
        [InlineData("  ", null, null, null)]
        [InlineData("a=1&App= ", null, null, null)]
        [InlineData("SQLAgent - TSQL JobStep (Job 0xAB : Step 1)", null, null, "SQL Agent")]
        [InlineData("Microsoft SQL Server Management Studio", "PC1", @"MRA\someone", "Microsoft SQL Server Management Studio")]
        public void App_name_is_worked_out_from_the_connection(string? program, string? host, string? login, string? app) =>
            Assert.Equal(app, HistoryStore.AppName(program, host, login));

        [Theory]
        [InlineData("SELECT * FROM [DROP] WHERE a = 'x;y'", true)]
        [InlineData("WITH a AS (SELECT 1 x) SELECT * FROM a", true)]
        [InlineData("SELECT * FROM t WHERE c = 'it''s'", true)]
        [InlineData("SELECT [a;b] FROM t", true)]
        [InlineData(" select 1; select 2", false)]
        [InlineData("SELECT 1 INTO #x", false)]
        [InlineData("EXEC p", false)]
        [InlineData("UPDATE t SET a = 1", false)]
        [InlineData("SELECT 1 DELETE FROM t", false)]
        public void Only_single_select_statements_are_allowed(string sql, bool allowed)
        {
            if (allowed) Db.AssertReadOnly(sql);
            else Assert.Throws<InvalidOperationException>(() => Db.AssertReadOnly(sql));
        }

        [Theory]
        [InlineData("2026-11-01", false, "2026-11-01T00:00:00")]
        [InlineData("2026-11-01", true, "2026-11-01T23:59:59.999")]
        [InlineData("2026-11-01 10:30", false, "2026-11-01T10:30:00")]
        [InlineData("2026-11-01 10:30", true, "2026-11-01T10:30:59.999")]
        [InlineData("2026-11-01T10:30", true, "2026-11-01T10:30:59.999")]
        [InlineData(" 2026-11-01 10:30:15 ", true, "2026-11-01T10:30:15")]
        [InlineData("2026-11-01T10:30:15.5", false, "2026-11-01T10:30:15.5")]
        public void Dates_are_normalised_for_sql_server(string value, bool end, string expected) =>
            Assert.Equal(expected, Serialize.IsoParam(value, end));

        [Theory]
        [InlineData("25", 25L)]
        [InlineData("  -7px", -7L)]
        [InlineData("+3.9", 3L)]
        [InlineData("abc", null)]
        [InlineData("", null)]
        [InlineData(null, null)]
        public void Whole_numbers_are_read_leniently(string? text, long? expected) => Assert.Equal(expected, Js.ParseInt(text));

        [Fact]
        public void Values_are_sent_as_plain_json_values()
        {
            Assert.Equal("2026-11-25 09:05:03.120", Serialize.Value(new DateTime(2026, 11, 25, 9, 5, 3, 120)));
            Assert.Equal("1970-01-01 13:45:00.000", Serialize.Value(new TimeSpan(13, 45, 0)));
            Assert.Equal("0x0AFF", Serialize.Value(new byte[] { 0x0A, 0xFF }));
            Assert.Equal($"0x{new string('0', 64)}… (40 bytes)", Serialize.Value(new byte[40]));
            Assert.Equal(1.5, Serialize.Value(1.50m));
            Assert.Equal("0F8FAD5B-D9CB-469F-A165-70867728950E", Serialize.Value(Guid.Parse("0f8fad5b-d9cb-469f-a165-70867728950e")));
            Assert.Null(Serialize.Value(DBNull.Value));
            Assert.Equal(42L, Serialize.Value(42L));
        }
    }
}
