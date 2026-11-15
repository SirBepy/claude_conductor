// asserts: scripts/wdio-sweep.ps1

// In a scratch worktree the app only has the main checkout's project registered, so every
// wdio spec that names its project after process.cwd() has to run from the main checkout
// (project_wdio_suite_traps #5); the rest stay in the worktree. The list used to hold only
// chat-flow and reload-dup, and the other six failed with "no project-picker row named
// <worktree folder>". The invocation is read by dot-sourcing the script, as
// scripts/wdio-sweep-verdict.test.ps1 does, with the scratch-worktree switch forced on.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const isWindows = process.platform === "win32";
const SCRIPT = resolve("scripts/wdio-sweep.ps1");
const SPECS = resolve("e2e/specs");

const cwdSpecs = readdirSync(SPECS)
  .filter((f) => f.endsWith(".e2e.js") && readFileSync(resolve(SPECS, f), "utf8").includes("process.cwd()"))
  .map((f) => f.replace(".e2e.js", ""));

function workingDirs(names) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$env:CARGO_TARGET_DIR = $env:TEMP",
    `. '${SCRIPT}' -WhatIf`,
    "$inScratchWorktree = $true",
    "$mainWorktree = 'C:\\fake\\main-checkout'",
    `foreach ($s in @(${names.map((n) => `'${n}'`).join(",")})) { $c = Get-WdioCommandLine -SpecName $s -LogPath 'x.log'; "$s|$($c.WorkingDirectory)" }`,
  ].join("; ");
  const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
  return Object.fromEntries(out.split(/\r?\n/).filter((l) => l.includes("|")).map((l) => l.split("|")));
}

describe.skipIf(!isWindows)("wdio-sweep.ps1 in a scratch worktree", () => {
  it("found the specs that read process.cwd()", () => {
    expect(cwdSpecs.length).toBeGreaterThanOrEqual(8);
  });

  it("runs every spec that reads process.cwd() from the main checkout", () => {
    const dirs = workingDirs(cwdSpecs);
    for (const name of cwdSpecs) expect(dirs[name], name).toBe("C:\\fake\\main-checkout");
  });

  it("keeps the specs that do not read it in the worktree", () => {
    const dirs = workingDirs(["smoke", "schedule-view", "daemon-lifecycle"]);
    for (const name of ["smoke", "schedule-view", "daemon-lifecycle"]) expect(dirs[name], name).not.toBe("C:\\fake\\main-checkout");
  });
});
