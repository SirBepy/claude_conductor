// Regression tests for the dashboard runtime wiring.
//
// Pure static-analysis tests over `src/` — they do NOT run the app. The CSP
// test still guards against Tauri IPC being silently blocked. The shim and
// script-load-order tests are skipped: the legacy electron-api-shim.js and
// dashboard.js are gone; their role is now played by src/main.ts and the
// per-view TS modules loaded via a single <script type="module">.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "..", "src");

const html = readFileSync(join(distDir, "index.html"), "utf8");

describe("dashboard.html CSP", () => {
  const cspMatch = html.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i
  );
  it("has a Content-Security-Policy meta tag", () => {
    expect(cspMatch).not.toBeNull();
  });

  const csp = cspMatch ? cspMatch[1] : "";
  const connectSrcMatch = csp.match(/connect-src\s+([^;]+)/);

  it("declares a connect-src directive (so default-src does not silently block IPC)", () => {
    expect(connectSrcMatch).not.toBeNull();
  });

  it("lets the phone page fetch the tunnel's journal port (its own port + 1)", () => {
    // link-journal.ts reads http://127.0.0.1:<page port + 1>/, a different origin from the page,
    // so 'self' does not cover it and a missing loopback entry blocks it silently.
    const sources = connectSrcMatch ? connectSrcMatch[1] : "";
    expect(sources).toContain("http://127.0.0.1:*");
  });

  it("permits Tauri 2 IPC endpoints", () => {
    const sources = connectSrcMatch ? connectSrcMatch[1] : "";
    // Tauri 2 on Windows routes invoke() to http://ipc.localhost; macOS uses
    // the `ipc:` scheme. Both must be reachable.
    expect(sources).toMatch(/ipc:/);
    expect(sources).toMatch(/http:\/\/ipc\.localhost/);
  });
});

// TODO(phase-4): legacy script-tag load order no longer applies — index.html
// loads a single ES module (`./main.ts`) that imports every view.
describe.skip("dashboard.html script load order", () => {
  it("loads electron-api-shim.js before anything that uses window.electronAPI", () => {});
  it("loads settings.js so the Version / Copy-Logs / launch-at-login wiring runs", () => {});
});

// TODO(phase-4): electron-api-shim.js was deleted. The Tauri IPC wrapper now
// lives in src/shared/ipc.ts and is a thin typed invoke() call site rather
// than a shape-translating shim, so these sandboxed-eval shape assertions no
// longer have a direct analogue.
describe.skip("electron-api-shim.js stub shapes", () => {
  it("exposes electronAPI after IIFE runs", () => {});
  it("backfillTranscripts invokes backfill_transcripts and returns processed/skipped", () => {});
  it("getTokenHistory and getActiveSessions return arrays so spread/iteration works", () => {});
  it("syncListDevices returns array (dashboard calls .map on it)", () => {});
  it("openInExplorer invokes open_in_explorer with the path argument", () => {});
  it("openInVSCode invokes open_in_vscode with the path argument", () => {});
  it("checkPathsExist forwards paths to check_paths_exist and returns the map", () => {});
  it("copyLogs delegates to backend copy_logs command", () => {});
});
