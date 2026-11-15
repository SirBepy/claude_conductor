// A real claude.exe for the fake CLI (compiled by scripts/wdio-sweep.ps1 and
// scripts/build-fake-claude.ps1 into this folder as claude.exe).
//
// claude.cmd cannot carry the main chat's long system prompt: Windows runs a .cmd
// through cmd.exe, which refuses a command line over 8191 characters ("The command
// line is too long"), so a chat with Use subchats on never started under the fake.
// An .exe is started by CreateProcess directly, which takes up to 32767. This shim
// only hands every argument, and its own stdin, stdout and stderr, to
// `node fake.cjs` and returns node's exit code.
using System;
using System.Diagnostics;
using System.IO;
using System.Text;

static class FakeClaudeShim
{
    // CommandLineToArgvW's inverse: wraps an argument in quotes, doubles the
    // backslashes that sit in front of a quote, and escapes each quote.
    static void Quote(StringBuilder sb, string arg)
    {
        sb.Append('"');
        int backslashes = 0;
        foreach (char c in arg)
        {
            if (c == '\\') { backslashes++; continue; }
            if (c == '"') { sb.Append('\\', backslashes * 2 + 1); sb.Append('"'); }
            else { sb.Append('\\', backslashes); sb.Append(c); }
            backslashes = 0;
        }
        sb.Append('\\', backslashes * 2);
        sb.Append('"');
    }

    static int Main(string[] args)
    {
        string script = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "fake.cjs");
        var line = new StringBuilder();
        Quote(line, script);
        foreach (string a in args) { line.Append(' '); Quote(line, a); }
        var psi = new ProcessStartInfo("node", line.ToString()) { UseShellExecute = false };
        using (Process p = Process.Start(psi))
        {
            p.WaitForExit();
            return p.ExitCode;
        }
    }
}
