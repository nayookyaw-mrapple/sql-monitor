using API.Services;
using Xunit;

namespace API.Tests
{
    /// <summary>What a SQL Agent job step runs, worked out from its command text.</summary>
    public class JobCommandTests
    {
        [Theory]
        [InlineData("sys.sp_MScdc_capture_job", "sys.sp_MScdc_capture_job")]
        [InlineData("EXEC dbo.ma_Heatmap_Bin_Build @SiteID = 1", "dbo.ma_Heatmap_Bin_Build")]
        [InlineData("exec [dbo].[DSL_ConnectionDetails]; EXECUTE @rc = MrApple.dbo.pk_Load 1", "[dbo].[DSL_ConnectionDetails], MrApple.dbo.pk_Load")]
        [InlineData("-- EXEC dbo.old\nDECLARE @s nvarchar(max) = N'x'; EXEC (@s); EXEC sp_executesql @s", "sp_executesql")]
        [InlineData("RAISERROR(22801, 10, -1)", "")]
        [InlineData("SELECT 1", "")]
        [InlineData("EXECUTE AS LOGIN = 'sa'; EXEC dbo.p; EXEC dbo.p", "dbo.p")]
        [InlineData("dbo.NoExecFirst @a = 1", "dbo.NoExecFirst")]
        public void Procedures_of_a_tsql_step(string command, string expected) =>
            Assert.Equal(expected, string.Join(", ", JobCommand.Procedures("TSQL", command)));

        [Fact]
        public void Procedures_are_only_read_from_tsql_steps() =>
            Assert.Empty(JobCommand.Procedures("CmdExec", "EXEC dbo.p"));

        [Theory]
        [InlineData(@"/ISSERVER ""\""\SSISDB\Loads\Daily\Import.dtsx\"""" /SERVER HQ", @"\SSISDB\Loads\Daily\Import.dtsx")]
        [InlineData(@"/FILE ""\""D:\SSIS Packages\Load.dtsx\"""" /CHECKPOINTING OFF", @"D:\SSIS Packages\Load.dtsx")]
        [InlineData(@"bcp MrApple.dbo.t out \\fileserver\export\bins.dat -T -c", @"\\fileserver\export\bins.dat")]
        [InlineData(@"BULK INSERT dbo.t FROM 'C:\Data In\file 1.csv' WITH (FIRSTROW = 2)", @"C:\Data In\file 1.csv")]
        [InlineData(@"powershell.exe -File C:\Scripts\clean.ps1; copy E:\a.txt ""F:\Out Box\""", @"F:\Out Box, C:\Scripts\clean.ps1, E:\a.txt")]
        [InlineData("EXEC dbo.p @a = 1", "")]
        public void Files_named_in_a_command(string command, string expected) =>
            Assert.Equal(expected, string.Join(", ", JobCommand.Files(command)));

        [Fact]
        public void Preview_is_one_shortened_line() =>
            Assert.Equal("EXEC dbo.p…", JobCommand.Preview("EXEC\r\n   dbo.p @a = 1", 10));
    }
}
