// asserts: scripts/bootstrap-worktree.ps1

// The worktree bootstrap's two Android gradle checks, run on the script's own function
// definitions (the script itself needs pnpm and a submodule fetch): a copied
// tauri.settings.gradle that names an older tauri than the Cargo.lock pins is reported
// stale, and a gradle input counts as present only when it holds something.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const isWindows = process.platform === "win32";
const SCRIPT = resolve("scripts/bootstrap-worktree.ps1");

let dir;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "bootstrap-gradle-")); });
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

const settings = (version) => `include ':tauri-android'\nproject(':tauri-android').projectDir = new File("C:\\\\Users\\\\x\\\\.cargo\\\\registry\\\\src\\\\index.crates.io-abc\\\\tauri-${version}\\\\mobile\\\\android")\n`;
const lock = (version) => `[[package]]\nname = "tao"\nversion = "0.1.0"\n\n[[package]]\nname = "tauri"\nversion = "${version}"\n`;

/** Runs the script's functions (not its body) and returns what `expr` prints. */
function run(expr) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile('${SCRIPT}', [ref]$null, [ref]$null)`,
    "foreach ($f in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) { . ([scriptblock]::Create($f.Extent.Text)) }",
    expr,
  ].join("; ");
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).trim();
}

describe.skipIf(!isWindows)("bootstrap-worktree.ps1 gradle checks", () => {
  it("reports a tauri.settings.gradle pinned to an older tauri than the Cargo.lock", () => {
    writeFileSync(join(dir, "old.gradle"), settings("2.10.1"));
    writeFileSync(join(dir, "Cargo.lock"), lock("2.11.5"));
    const out = run(`Get-StaleGradleSettingsReason '${join(dir, "old.gradle")}' '${join(dir, "Cargo.lock")}'`);
    expect(out).toContain("2.10.1");
    expect(out).toContain("2.11.5");
  });

  it("reports nothing when the versions agree, or when either file is missing", () => {
    writeFileSync(join(dir, "same.gradle"), settings("2.11.5"));
    writeFileSync(join(dir, "Cargo.lock"), lock("2.11.5"));
    expect(run(`Get-StaleGradleSettingsReason '${join(dir, "same.gradle")}' '${join(dir, "Cargo.lock")}'`)).toBe("");
    expect(run(`Get-StaleGradleSettingsReason '${join(dir, "none.gradle")}' '${join(dir, "Cargo.lock")}'`)).toBe("");
    expect(run(`Get-StaleGradleSettingsReason '${join(dir, "same.gradle")}' '${join(dir, "none.lock")}'`)).toBe("");
  });

  it("counts a gradle input as present only when it is a file or a folder with something in it", () => {
    writeFileSync(join(dir, "keystore.properties"), "x");
    mkdirSync(join(dir, "empty-generated"));
    mkdirSync(join(dir, "full-generated"));
    writeFileSync(join(dir, "full-generated", "TauriActivity.kt"), "x");
    const out = run([
      `"$(Test-GradleInputPresent '${join(dir, "keystore.properties")}')"`,
      `"$(Test-GradleInputPresent '${join(dir, "empty-generated")}')"`,
      `"$(Test-GradleInputPresent '${join(dir, "full-generated")}')"`,
      `"$(Test-GradleInputPresent '${join(dir, "missing")}')"`,
    ].join("; "));
    expect(out.split(/\r?\n/)).toEqual(["True", "False", "True", "False"]);
  });
});
