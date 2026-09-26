using System;
using System.Diagnostics;
using System.IO;

// Chrome and Edge on Windows start Native Messaging hosts only as Windows programs. This
// relay starts the WebMCP host inside WSL; the browser's stdin and stdout pass
// straight through to it. register.ps1 fills in the two values when it compiles the relay.
internal static class DeepSeekWebMcpRelay
{
    private static string Quote(string value)
    {
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    public static int Main(string[] args)
    {
        var distro = "__DEEPSEEK_WEBMCP_DISTRO__";
        var launcher = "__DEEPSEEK_WEBMCP_LAUNCHER__";
        var wsl = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "wsl.exe");
        var start = new ProcessStartInfo
        {
            FileName = wsl,
            Arguments = "-d " + Quote(distro) + " --exec " + Quote(launcher),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = false,
            RedirectStandardOutput = false,
            RedirectStandardError = false
        };
        try
        {
            using (var child = Process.Start(start))
            {
                if (child == null) return 70;
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch
        {
            return 71;
        }
    }
}
