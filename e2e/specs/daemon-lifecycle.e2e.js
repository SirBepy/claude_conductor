// Phase 7 regression + Phase 6 lifecycle (ai_todo 74).
//
// Three layers of coverage:
// 1. Connectivity: proves the running app is daemon-backed (no app-side fallback).
// 2. Close/reopen: daemon survives app close; new app instance reconnects.
// 3. Kill/respawn: daemon dies unexpectedly; app reconnect loop respawns it.
//
// All run against an isolated CC_DAEMON_INSTANCE=wdio daemon so tests never
// touch a real cc-conductor-daemon the user has running. Free - no billed turn.

import { execSync } from "node:child_process";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Checks for either the standalone harness daemon or the app-respawned daemon.
function companionDaemonRunning() {
  const csv = execSync("tasklist /FO CSV /NH", { encoding: "utf8" });
  return /"cc-conductor-daemon\.exe"/i.test(csv);
}

// Checks for a claude-conductor.exe process launched with --daemon (the app's
// reconnect-loop respawn target after the harness daemon is killed). The
// installed app's own daemon has the SAME command line, so PIDs that existed
// before the harness started are excluded or this asserts nothing.
const PREEXISTING = new Set((process.env.CC_WDIO_PREEXISTING_DAEMON_PIDS || "").split(",").filter(Boolean));

function respawnedDaemonRunning() {
  try {
    const out = execSync(
      "powershell -Command \"Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'claude-conductor.exe' " +
      "-and $_.CommandLine -like '*--daemon*' } | ForEach-Object { $_.ProcessId }\"",
      { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }
    );
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).some((pid) => !PREEXISTING.has(pid));
  } catch {
    return false;
  }
}

describe("Daemon-backed Sessions (Phase 7: daemon is sole chat path)", () => {
  it("a companion daemon process is running while the app is up", () => {
    expect(companionDaemonRunning()).toBe(true);
  });

  it("Sessions view renders from the daemon snapshot", async () => {
    // window.showView is exposed globally by src/shared/navigation.ts.
    await browser.execute(() => window.showView("sessions"));

    const view = await $(".view-sessions");
    await view.waitForExist({ timeout: 15000 });

    // #sessions-list is populated from the daemon's instance snapshot on
    // connect (list_instances RPC). With no daemon connection there would be
    // no snapshot path to render it - so its existence proves the daemon link.
    const list = await $("#sessions-list");
    await list.waitForExist({ timeout: 15000 });
    await expect(list).toExist();
  });
});

describe("Daemon lifecycle: close/reopen and kill/respawn (ai_todo 74)", () => {
  it("daemon survives app close; new app instance reconnects", async () => {
    expect(companionDaemonRunning()).toBe(true);

    // reloadSession() tears down the current WebDriver session (killing the
    // app) and immediately creates a new one (launching the app again). The
    // daemon (spawned in onPrepare, outside the session lifecycle) must survive.
    await browser.reloadSession();

    expect(companionDaemonRunning()).toBe(true);

    // New app instance should reconnect via the existing daemon and render.
    await browser.execute(() => window.showView("sessions"));
    const list = await $("#sessions-list");
    await list.waitForExist({ timeout: 20000 });
    await expect(list).toExist();
  });

  it("app reconnect loop respawns daemon after unexpected exit", async () => {
    // Kill the harness daemon (cc-conductor-daemon.exe). The app's
    // run_app_subscription loop detects the pipe drop and calls ensure_daemon()
    // which spawns `claude-conductor.exe --daemon` with CC_DAEMON_INSTANCE
    // inherited from the app env (so it uses the wdio pipe, not production).
    // By PID, not by name: a kill-by-name would also take out any real
    // cc-conductor-daemon the user happens to be running.
    try {
      execSync(`powershell -Command "Stop-Process -Id ${process.env.CC_WDIO_DAEMON_PID} -Force"`);
    } catch {}

    // Wait up to 20s for the respawned daemon to appear.
    const deadline = Date.now() + 20000;
    let respawned = false;
    while (Date.now() < deadline) {
      await sleep(800);
      if (respawnedDaemonRunning()) { respawned = true; break; }
    }
    expect(respawned).toBe(true);

    // Sessions view must re-render after the reconnect loop reattaches.
    await browser.execute(() => window.showView("sessions"));
    const list = await $("#sessions-list");
    await list.waitForExist({ timeout: 20000 });
    await expect(list).toExist();
  });
});
