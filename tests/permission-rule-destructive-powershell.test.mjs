import { describe, it, expect } from "vitest";
import { isDestructive } from "../src/views/sessions/permission-rules.ts";

// todo 997: isDestructive used to open with `if (toolName !== "Bash") return
// false`, so a destructive PowerShell command (the primary shell on this
// Windows-first app) never reached the pattern list at all. It now keys on
// the input having a string `command` field instead of a hardcoded tool
// name, and gained PowerShell-native `Remove-Item -Recurse -Force`
// detection (any flag order, aliases, PowerShell-legal abbreviations).

function ps(command) {
  return { command };
}

describe("PowerShell recursive+force deletion is flagged, in any shape", () => {
  const destructive = [
    "Remove-Item -Recurse -Force C:\\temp",
    "Remove-Item -Force -Recurse C:\\temp", // flag order independent
    "Remove-Item -r -fo C:\\temp", // abbreviated flags
    "Remove-Item -Rec -Force C:\\temp",
    "ri -Recurse -Force .\\build", // alias
    "rm -Recurse -Force .\\build", // PowerShell's own rm alias, not bash rm
    "del -Recurse -Force .\\build",
    "rd -Recurse -Force .\\build",
    "rmdir -Recurse -Force .\\build",
    "erase -Recurse -Force .\\build",
    "Remove-Item -Recurse -Force -Confirm:$false C:\\temp", // extra flags around it
  ];
  for (const command of destructive) {
    it(`flags: ${command}`, () => {
      expect(isDestructive("PowerShell", ps(command))).toBe(true);
    });
  }
});

describe("PowerShell commands that must NOT be flagged", () => {
  const harmless = [
    "Remove-Item foo.txt", // no recurse, no force
    "Remove-Item -Recurse foo", // recurse alone
    "Remove-Item -Force foo.txt", // force alone
    "Get-ChildItem -Recurse", // recurse flag, but not a removal verb
    "Get-ChildItem -Recurse -Force", // same, force too - still not Remove-Item
    "Remove-Item file.txt; Get-ChildItem -Recurse -Force", // flags land on a DIFFERENT statement
    "Copy-Item -Recurse -Force .\\src .\\dst", // recurse+force but not a removal verb
  ];
  for (const command of harmless) {
    it(`does not flag: ${command}`, () => {
      expect(isDestructive("PowerShell", ps(command))).toBe(false);
    });
  }
});

describe("cross-shell text patterns still apply to PowerShell's command text", () => {
  it("git push --force", () => {
    expect(isDestructive("PowerShell", ps("git push --force origin main"))).toBe(true);
  });
  it("git reset --hard", () => {
    expect(isDestructive("PowerShell", ps("git reset --hard HEAD~1"))).toBe(true);
  });
  it("dd if=", () => {
    expect(isDestructive("PowerShell", ps("dd if=/dev/zero of=/dev/sda"))).toBe(true);
  });
  it("Format-Volume", () => {
    expect(isDestructive("PowerShell", ps("Format-Volume -DriveLetter D"))).toBe(true);
  });
  it("Clear-Disk", () => {
    expect(isDestructive("PowerShell", ps("Clear-Disk -Number 1 -RemoveData"))).toBe(true);
  });
});

describe("keyed on the command field, not a hardcoded tool name", () => {
  it("still flags Bash the same as before (no regression)", () => {
    expect(isDestructive("Bash", ps("rm -rf /tmp/x"))).toBe(true);
    expect(isDestructive("Bash", ps("ls -la"))).toBe(false);
  });
  it("a tool with no command field is never flagged", () => {
    expect(isDestructive("Write", { file_path: "/a.txt" })).toBe(false);
  });
  it("a made-up shell-ish tool name is flagged purely on the command shape", () => {
    expect(isDestructive("SomeFutureShellTool", ps("Remove-Item -Recurse -Force C:\\temp"))).toBe(true);
  });
});
