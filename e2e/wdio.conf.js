// WebdriverIO config for the Tauri UI smoke layer (ai_todo 67, "both layers").
//
// Windows/Linux only - tauri-driver has no macOS (WKWebView) support. Drives the
// already-built DEBUG binary, so run `cargo build` (or `cargo tauri dev` once)
// first. Run with: npm run test:e2e
//
// Debugging a failing spec: use the reusable probe instead of a throwaway
// file - PROBE_VIEW=<view> PROBE_SELECTOR="<css>" npm run test:e2e:probe
//
// Scope: boot the app shell + render the Sessions view with the daemon
// connected. The daemon is spawned here with CC_DAEMON_NO_AUTOSTART so it does
// NOT launch real automation channels (which would pile up duplicate Claude
// desktop bridges every run).

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
// Cargo's target dir is not repo-local here: the global ~/.cargo/config.toml
// points it at D:/cargo-target, so a hardcoded src-tauri/target/debug spawns
// ENOENT. Ask cargo where it actually put things.
const cargoTargetDir = (() => {
  if (process.env.CARGO_TARGET_DIR) return process.env.CARGO_TARGET_DIR;
  const meta = execSync("cargo metadata --no-deps --format-version 1", {
    cwd: path.join(repoRoot, "src-tauri"),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(meta).target_directory;
})();
const debugDir = path.resolve(cargoTargetDir, "debug");
const application = path.join(debugDir, "claude-conductor.exe");
const daemonBin = path.join(debugDir, "cc-conductor-daemon.exe");
const tauriDriverBin = path.resolve(os.homedir(), ".cargo", "bin", "tauri-driver.exe");
const edgeDriver = path.resolve(__dirname, "drivers", "msedgedriver.exe");
// e2e/drivers/ is gitignored (per-machine), so a fresh clone has no record of which
// msedgedriver build it needs until it hits the wall todo 956 describes. As of
// 2026-09-25 the required major version is 153, matching the installed WebView2
// runtime on this machine - checkEdgeDriverVersion() below re-verifies this at every
// run rather than trusting the number to stay current. Download a matching driver from
// https://msedgedriver.microsoft.com/<full-version>/edgedriver_win64.zip and drop it at
// e2e/drivers/msedgedriver.exe.
// Isolated instance: distinct pipe/lockfile/hook-port so the harness daemon and
// any app-respawned daemon never collide with a real cc-conductor-daemon the
// user has running (ai_todo 71 / ai_todo 74).
const DAEMON_INSTANCE = "wdio";
const daemonLock = path.join(os.homedir(), "AppData", "Roaming", "claude-conductor", `daemon-${DAEMON_INSTANCE}.lock`);
// The debug app binary loads Tauri's devUrl (http://localhost:1420). A live
// `vite dev` server there means a peer's concurrent save under src/ hot-reloads
// into a running billed test (ai_todo 868). Build once, then serve the fixed
// dist/ via `vite preview`, so a run is a verdict about one artifact.
const viteBin = path.resolve(repoRoot, "node_modules", "vite", "bin", "vite.js");
const DEV_URL = "http://localhost:1420";

let tauriDriver;
let daemon;
let vite;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// todo 956: a stale msedgedriver makes EVERY spec fail at session creation, in the
// `before` hook, with an error that reads as "the app broke" rather than "the driver is
// stale" - it cost most of an hour on 2026-09-24. Exported so the isolation check in the
// todo's verify floor can call these directly without spawning the real suite.

/** The installed WebView2 runtime's full version string, e.g. "153.0.4234.48". This is
 *  what actually diagnosed the 2026-09-24 incident - `pv` on the "Microsoft Edge WebView2
 *  Runtime" client under EdgeUpdate's registered products. */
export function getInstalledWebView2Version() {
  const out = execSync(
    "powershell -NoProfile -Command " +
      JSON.stringify(
        "Get-ChildItem 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients' | " +
          "ForEach-Object { $p = Get-ItemProperty $_.PSPath; " +
          "if ($p.name -eq 'Microsoft Edge WebView2 Runtime') { $p.pv } }"
      ),
    { encoding: "utf8" }
  ).trim();
  if (!out) {
    throw new Error(
      "[wdio] Could not read the installed WebView2 runtime version from " +
        "HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients - is WebView2 installed?"
    );
  }
  return out;
}

/** Compares `driverPath --version`'s major version against `installedRuntimeVersion`'s
 *  major version and throws a one-line, actionable error naming both full versions plus
 *  the download URL if they differ - never lets a version skew masquerade as 8 broken
 *  specs. Returns `{ driverVersion, runtimeVersion }` on a match. */
export function checkEdgeDriverVersion(driverPath, installedRuntimeVersion) {
  const driverOutput = execSync(`${JSON.stringify(driverPath)} --version`, { encoding: "utf8" }).trim();
  const driverMatch = driverOutput.match(/Microsoft Edge WebDriver ([\d.]+)/);
  if (!driverMatch) {
    throw new Error(`[wdio] Could not parse "${driverPath} --version" output: "${driverOutput}"`);
  }
  const driverVersion = driverMatch[1];
  const driverMajor = driverVersion.split(".")[0];
  const runtimeMajor = installedRuntimeVersion.split(".")[0];
  if (driverMajor !== runtimeMajor) {
    throw new Error(
      `[wdio] msedgedriver/WebView2 version mismatch - every spec would fail at session ` +
        `creation. Driver at ${driverPath} is ${driverVersion} (major ${driverMajor}); the ` +
        `installed WebView2 runtime is ${installedRuntimeVersion} (major ${runtimeMajor}). ` +
        `Download the matching driver from ` +
        `https://msedgedriver.microsoft.com/${installedRuntimeVersion}/edgedriver_win64.zip ` +
        `and replace ${driverPath}.`
    );
  }
  return { driverVersion, runtimeVersion: installedRuntimeVersion };
}

// The debug binary auto-opens ONLY the Chats window (`bootstrap.rs:29-31`) and
// builds the dashboard lazily (`:33-37`), so tauri-driver binds to
// `session-chats` where `main.ts:206` has stripped `#sidemenu`. Root cause of
// every rotted opt-in spec (ai_todo 649/688).
async function switchToMainWindow() {
  await browser.waitUntil(
    async () => browser.execute(() => !!window.__TAURI__?.core?.invoke).catch(() => false),
    { timeout: 30000, interval: 300, timeoutMsg: "__TAURI__.core.invoke never appeared" }
  );
  await browser.execute(() => window.__TAURI__.core.invoke("open_dashboard"));

  await browser.waitUntil(
    async () => {
      for (const handle of await browser.getWindowHandles()) {
        await browser.switchToWindow(handle);
        const isMain = await browser
          .execute(() => !location.search.includes("chatswindow") && typeof window.showView === "function")
          .catch(() => false);
        if (isMain) return true;
      }
      return false;
    },
    { timeout: 30000, interval: 400, timeoutMsg: "main dashboard window never became drivable" }
  );

  // The dashboard opens at 520x720 and window-state then restores the dev's
  // saved geometry - both hit the phone layout. Its restore lands after the
  // webview is drivable, so hold the width instead of setting it once.
  let stable = 0;
  await browser.waitUntil(
    async () => {
      const width = await browser.execute(() => window.innerWidth).catch(() => 0);
      if (width >= 1200) {
        stable += 1;
        return stable >= 3;
      }
      stable = 0;
      await browser.setWindowSize(1400, 900);
      return false;
    },
    { timeout: 30000, interval: 500, timeoutMsg: "main window never held a desktop-width viewport" }
  );
}

// The INSTALLED app runs its daemon as `claude-conductor.exe --daemon` too, so
// matching that command line alone cannot tell prod from a harness respawn.
// Snapshot the PIDs that already exist before the harness starts; everything
// else in that set is ours. Without this, onComplete killed the user's daemon.
function daemonPidsNow() {
  try {
    const out = execSync(
      "powershell -Command \"Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'claude-conductor.exe' " +
      "-and $_.CommandLine -like '*--daemon*' } | ForEach-Object { $_.ProcessId }\"",
      { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }
    );
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastBody = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      lastBody = await res.text();
      // Identity check: a *different* project's dev server may already own
      // port 1420 (both claude_usage and some sibling repos configure vite to
      // 1420, and our --strictPort spawn then silently fails to bind). Without
      // this check the Tauri app loads the FOREIGN SPA and every spec dies with
      // a baffling `window.showView is not a function` / missing `#sidemenu`.
      // Require a marker unique to this app's index.html before proceeding.
      if (lastBody.includes('id="sidemenu"') || lastBody.includes("<title>Claude Conductor</title>")) {
        return;
      }
      // Reachable but wrong app — fail fast with an actionable message rather
      // than waiting out the timeout and then mis-loading the wrong page.
      throw new Error(
        `Port 1420 is serving a DIFFERENT app (no claude_usage marker found). ` +
        `Another project's dev server (e.g. server_supervisor) is likely running on 1420. ` +
        `Stop it and re-run. First 200 chars:\n${lastBody.slice(0, 200)}`
      );
    } catch (e) {
      // Re-throw the identity-mismatch error immediately; only swallow the
      // connection-refused churn while the server is still coming up.
      if (e instanceof Error && e.message.startsWith("Port 1420 is serving")) throw e;
      await sleep(300);
    }
  }
  throw new Error(`vite preview server not up (or not ours) at ${url} within ${timeoutMs}ms`);
}

export const config = {
  runner: "local",
  host: "127.0.0.1",
  port: 4444,
  // Free smoke by default. The billed chat test (reload-dup) is opt-in via
  // `npm run test:e2e:chat` (passes --spec), so the default run spawns no
  // `claude` turn.
  specs: [
    path.join(__dirname, "specs", "smoke.e2e.js"),
    path.join(__dirname, "specs", "daemon-lifecycle.e2e.js"),
  ],
  maxInstances: 1,
  capabilities: [{ "tauri:options": { application } }],
  reporters: ["spec"],
  framework: "mocha",
  // 240s: the billed specs wait up to 120s for a reply, so a 120s budget killed
  // them mid-wait and surfaced a bare "Timeout" instead of the real error.
  mochaOpts: { ui: "bdd", timeout: 240000 },
  logLevel: "warn",

  // Spawn the daemon before the app launches so the Sessions view renders from
  // its snapshot. No-autostart keeps it from spawning real automation channels.
  onPrepare: async () => {
    // Fails fast, before the build/vite/daemon spawns below, so a stale driver costs
    // seconds instead of burning every spec's retries on an opaque session-creation
    // error (todo 956).
    checkEdgeDriverVersion(edgeDriver, getInstalledWebView2Version());

    // Propagate the instance label into the current process env so that
    // tauri-driver (spawned in beforeSession without an explicit env) inherits
    // it, passes it to the app, and the app's reconnect loop + respawn both
    // resolve to the same isolated pipe/lockfile (ai_todo 74).
    process.env.CC_DAEMON_INSTANCE = DAEMON_INSTANCE;
    // Specs run in a worker process, so the snapshot travels via env.
    process.env.CC_WDIO_PREEXISTING_DAEMON_PIDS = daemonPidsNow().join(",");

    // 1. Build once (execSync throws loud on a bad exit), then serve dist/.
    const commit = (() => {
      try {
        return execSync("git rev-parse --short HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
      } catch {
        return "unknown";
      }
    })();
    const dirty = (() => {
      try {
        return execSync("git status --porcelain", { cwd: repoRoot, encoding: "utf8" }).trim().length > 0;
      } catch {
        return "unknown";
      }
    })();
    console.log(`[wdio] testing built dist/ at commit ${commit}${dirty ? " (dirty tree)" : ""}`);
    execSync(`${JSON.stringify(process.execPath)} ${JSON.stringify(viteBin)} build`, {
      cwd: repoRoot,
      stdio: "inherit",
    });
    vite = spawn(process.execPath, [viteBin, "preview", "--port", "1420", "--strictPort"], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    await waitForServer(DEV_URL, 30000);

    // 2. Daemon (no-autostart so it doesn't spawn real automation channels).
    try {
      if (fs.existsSync(daemonLock)) fs.rmSync(daemonLock);
    } catch (e) {
      console.warn("could not clear daemon lock:", e.message);
    }
    daemon = spawn(daemonBin, [], {
      stdio: "ignore",
      env: {
        ...process.env,
        CC_DAEMON_NO_AUTOSTART: "1",
        CC_DAEMON_INSTANCE: DAEMON_INSTANCE,
        // stdio is "ignore", so daemon-<instance>.log is the only record of a
        // billed run. The pump's raw stdout trace is what makes that record
        // worth reading (todo 719).
        RUST_LOG:
          process.env.RUST_LOG ||
          "info,claude_conductor_lib=debug,claude_conductor_lib::daemon::pump=trace,iroh=warn,iroh_relay=warn,quinn=warn,netwatch=warn,portmapper=warn,tracing::span=warn",
      },
    });
    process.env.CC_WDIO_DAEMON_PID = String(daemon.pid);
    // Give the daemon a moment to bind its named pipe before the app connects.
    await sleep(1200);
  },
  onComplete: () => {
    if (daemon) daemon.kill();
    if (vite) vite.kill();
    // Clean up any claude-conductor.exe --daemon orphan the app may have
    // spawned during the kill/respawn test (ai_todo 74) - but ONLY ours.
    const preexisting = new Set((process.env.CC_WDIO_PREEXISTING_DAEMON_PIDS || "").split(",").filter(Boolean));
    for (const pid of daemonPidsNow()) {
      if (preexisting.has(pid)) continue;
      try {
        execSync(`powershell -Command "Stop-Process -Id ${pid} -Force"`, { stdio: "ignore" });
      } catch {}
    }
  },

  // tauri-driver is the WebDriver intermediary; it launches the app and proxies
  // to msedgedriver (must version-match the installed Edge/WebView2).
  beforeSession: () => {
    tauriDriver = spawn(tauriDriverBin, ["--native-driver", edgeDriver], {
      stdio: [null, process.stdout, process.stderr],
    });
  },
  // daemon-lifecycle's reloadSession() drops back to the chats window; it only
  // asserts `#sessions-list`, which exists in both, so it is left alone.
  before: async () => {
    await switchToMainWindow();
  },
  afterSession: () => {
    if (tauriDriver) tauriDriver.kill();
  },
};
