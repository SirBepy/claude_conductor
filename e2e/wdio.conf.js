// WebdriverIO config for the Tauri UI smoke layer (ai_todo 67, "both layers").
//
// Windows/Linux only - tauri-driver has no macOS (WKWebView) support. Drives the
// already-built DEBUG binary, so run `cargo build` (or `cargo tauri dev` once)
// first. Run with: npm run test:e2e
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
// Isolated instance: distinct pipe/lockfile/hook-port so the harness daemon and
// any app-respawned daemon never collide with a real cc-conductor-daemon the
// user has running (ai_todo 71 / ai_todo 74).
const DAEMON_INSTANCE = "wdio";
const daemonLock = path.join(os.homedir(), "AppData", "Roaming", "claude-conductor", `daemon-${DAEMON_INSTANCE}.lock`);
// The debug app binary loads Tauri's devUrl (http://localhost:1420), not the
// bundled dist/. So the harness runs the vite dev server itself rather than
// requiring a slow `cargo tauri build`. Spawn vite's JS directly to skip the
// `predev` kill-stale hook (which would kill our daemon).
const viteBin = path.resolve(repoRoot, "node_modules", "vite", "bin", "vite.js");
const DEV_URL = "http://localhost:1420";

let tauriDriver;
let daemon;
let vite;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  throw new Error(`vite dev server not up (or not ours) at ${url} within ${timeoutMs}ms`);
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
  mochaOpts: { ui: "bdd", timeout: 120000 },
  logLevel: "warn",

  // Spawn the daemon before the app launches so the Sessions view renders from
  // its snapshot. No-autostart keeps it from spawning real automation channels.
  onPrepare: async () => {
    // Propagate the instance label into the current process env so that
    // tauri-driver (spawned in beforeSession without an explicit env) inherits
    // it, passes it to the app, and the app's reconnect loop + respawn both
    // resolve to the same isolated pipe/lockfile (ai_todo 74).
    process.env.CC_DAEMON_INSTANCE = DAEMON_INSTANCE;
    // Specs run in a worker process, so the snapshot travels via env.
    process.env.CC_WDIO_PREEXISTING_DAEMON_PIDS = daemonPidsNow().join(",");

    // 1. Vite dev server (the debug app loads it via devUrl).
    vite = spawn(process.execPath, [viteBin, "--port", "1420", "--strictPort"], {
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
      env: { ...process.env, CC_DAEMON_NO_AUTOSTART: "1", CC_DAEMON_INSTANCE: DAEMON_INSTANCE },
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
  afterSession: () => {
    if (tauriDriver) tauriDriver.kill();
  },
};
