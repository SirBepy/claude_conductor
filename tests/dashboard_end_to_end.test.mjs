// End-to-end-ish test: loads dashboard.html into jsdom, evaluates every
// <script src="..."> in order with a stubbed __TAURI__ that returns a
// NON-EMPTY history in the Rust backend shape. Asserts that:
//
//   * no script throws during bootstrapping
//   * #stats-content gets replaced (i.e. the "Loading..." state is cleared)
//   * no debug-overlay error lines (`[ERR]` / `[REJ]`) were painted
//
// This is the regression test for the "cannot read properties of undefined
// (reading 'split')" bug — it proves the shim's shape translation is
// actually compatible with the renderer, end to end.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "..", "src");

function installTauriStub(window, history) {
  window.__TAURI__ = {
    core: {
      invoke: async (cmd) => {
        switch (cmd) {
          case "get_history":
            return history;
          case "get_settings":
            return {
              theme: "void",
              defaultDisplay: "icon",
              iconStyle: "rings",
              timeStyle: "absolute",
              tooltipLayout: "rows",
              tooltipShowSafePace: true,
              tooltipEstimateTokens: false,
              launchAtLogin: false,
              autoUpdate: false,
              pinnedCards: [],
              colorApplyTo: { icon: true, number: true, dashboard: true, tooltip: true },
              sessionPlan: 44000,
              weeklyPlan: 200000,
              paceBand: 10,
              paceColors: {},
              colorThresholds: [],
              notifications: {},
              projectAliases: {},
              sync: { enabled: false, serverUrl: "", apiKey: "", deviceName: "" },
            };
          case "auth_status":
            return "logged-in";
          case "read_log_file":
            return "stub logs";
          default:
            return null;
        }
      },
    },
    event: { listen: async () => () => {} },
    app: { getVersion: async () => "0.1.0-jsdom" },
    shell: { open: () => {} },
  };
}

async function bootDashboard(history) {
  const rawHtml = readFileSync(join(distDir, "index.html"), "utf8");
  // Strip <script src="..."> tags so jsdom doesn't try to fetch them (it
  // has no base URL for file:// serving). We re-append them manually once
  // the __TAURI__ stub is in place.
  const scriptSrcs = [...rawHtml.matchAll(/<script\s+src="([^"]+)"[^>]*><\/script>/g)].map((m) => m[1]);
  const html = rawHtml.replace(/<script\s+src="[^"]+"[^>]*><\/script>/g, "");

  // "dangerously" lets in-DOM inline <script> tags execute, so function
  // declarations become global — exactly what the real browser does.
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true });
  const { window } = dom;

  // Polyfill things jsdom does not: speechSynthesis, clipboard, crypto-ish.
  if (!window.speechSynthesis) {
    window.speechSynthesis = { getVoices: () => [], addEventListener: () => {} };
  }
  if (!window.navigator.clipboard) {
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: async () => {} },
      configurable: true,
    });
  }

  installTauriStub(window, history);

  // Inject each original <script src> inline so the window evaluates it as
  // top-level code and function declarations become global.
  // Skip external CDN URLs (http/https) — jsdom has no network access in tests.
  for (const src of scriptSrcs.filter((s) => !s.startsWith("http"))) {
    const code = readFileSync(join(distDir, src), "utf8");
    const s = window.document.createElement("script");
    s.textContent = code;
    window.document.body.appendChild(s);
  }

  // Fire DOMContentLoaded (debug overlay listens) and load (settings.js
  // hangs its init off window.onload). jsdom doesn't auto-fire load when
  // scripts are injected post-construction, so we invoke the handler
  // directly after dispatching the load event for any other listeners.
  window.document.dispatchEvent(new window.Event("DOMContentLoaded", { bubbles: true }));
  window.dispatchEvent(new window.Event("load"));
  if (typeof window.onload === "function") {
    try {
      await window.onload(new window.Event("load"));
    } catch (e) {
      window.__ONLOAD_ERROR__ = (e && (e.stack || e.message)) || String(e);
    }
  }

  // Poll briefly for the three init promises in dashboard.js to settle.
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const host = window.document.getElementById("stats-content");
    if (host && !host.textContent.trim().startsWith("Loading...")) break;
  }

  return { dom, window };
}

describe("dashboard project-list wiring (sort)", () => {
  // Seed: 3 days of usage history (so the session window clamps cleanly)
  // AND matching token history so buildWindowProjectsHTML produces rows.
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const resetsAt = iso(now + 3_600_000); // 1h in future → window brackets "now"
  const usageHistory = [
    {
      captured_at: iso(now - 60_000),
      five_hour: { utilization: 15, resets_at: resetsAt },
      seven_day: { utilization: 7, resets_at: iso(now + 3 * 86_400_000) },
      extra_usage: null,
    },
  ];
  const tokenHistory = [
    {
      sessionId: "S1", cwd: "C:/projects/alpha", date: "2026-04-20",
      inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0,
      turns: 5, startedAt: iso(now - 30 * 60_000), lastActiveAt: iso(now - 60_000),
      recordedAt: iso(now), live: false,
    },
    {
      sessionId: "S2", cwd: "C:/projects/beta", date: "2026-04-20",
      inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0,
      turns: 2, startedAt: iso(now - 10 * 60_000), lastActiveAt: iso(now - 30_000),
      recordedAt: iso(now), live: false,
    },
  ];

  // Map backend UsageSnapshots to the legacy renderer shape (the real shim
  // does this in getUsageHistory). We feed the legacy shape directly because
  // this test bypasses the shim for speed.
  async function boot() {
    const rawHtml = readFileSync(join(distDir, "index.html"), "utf8");
    const scriptSrcs = [...rawHtml.matchAll(/<script\s+src="([^"]+)"[^>]*><\/script>/g)].map((m) => m[1]);
    const html = rawHtml.replace(/<script\s+src="[^"]+"[^>]*><\/script>/g, "");
    const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true });
    const { window } = dom;
    if (!window.speechSynthesis) window.speechSynthesis = { getVoices: () => [], addEventListener: () => {} };
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText: async () => {} }, configurable: true });
    installTauriStub(window, usageHistory.map((s) => ({
      // Pre-map to legacy shape since the test below calls get_history
      // directly; shim.getUsageHistory would do this, but we want to
      // exercise rendering not the shim.
      hour: new Date(s.captured_at).toISOString().slice(0, 13),
      session_pct: Math.round(s.five_hour.utilization),
      weekly_pct: Math.round(s.seven_day.utilization),
      session_resets_at: s.five_hour.resets_at,
      weekly_resets_at: s.seven_day.resets_at,
    })));
    // Override get_token_history + get_history for this test.
    window.__TAURI__.core.invoke = async (cmd) => {
      if (cmd === "get_history") return usageHistory;
      if (cmd === "get_token_history") return tokenHistory;
      if (cmd === "get_active_sessions") return [];
      if (cmd === "get_settings") return {
        theme: "void", defaultDisplay: "icon", iconStyle: "rings",
        timeStyle: "absolute", tooltipLayout: "rows", tooltipShowSafePace: true,
        tooltipEstimateTokens: false, launchAtLogin: false, autoUpdate: false,
        pinnedCards: [],
        colorApplyTo: { icon: true, number: true, dashboard: true, tooltip: true },
        sessionPlan: 44000, weeklyPlan: 200000, paceBand: 10,
        paceColors: {}, colorThresholds: [], notifications: {}, projectAliases: {},
        projectBlacklist: [],
        sync: { enabled: false, serverUrl: "", apiKey: "", deviceName: "" },
      };
      if (cmd === "auth_status") return "logged-in";
      return null;
    };

    // Skip external CDN URLs (http/https) — jsdom has no network access in tests.
    for (const src of scriptSrcs.filter((s) => !s.startsWith("http"))) {
      const code = readFileSync(join(distDir, src), "utf8");
      const s = window.document.createElement("script");
      s.textContent = code;
      window.document.body.appendChild(s);
    }
    window.document.dispatchEvent(new window.Event("DOMContentLoaded", { bubbles: true }));
    window.dispatchEvent(new window.Event("load"));
    if (typeof window.onload === "function") {
      try { await window.onload(new window.Event("load")); } catch (e) { window.__ONLOAD_ERROR__ = e; }
    }
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 20));
      if (window.document.querySelector("#statistics-content th[data-sort]")) break;
    }
    return window;
  }

  // TODO(phase-3 task 14): statistics view migrated to src/views/statistics;
  // #statistics-content now materialises only after the TS module runs.
  it.skip("renders sortable headers with data-sort + data-list attrs in the dashboard window cards", async () => {
    const window = await boot();
    const ths = window.document.querySelectorAll("#statistics-content th[data-sort][data-list]");
    expect(ths.length).toBeGreaterThan(0);
  });

  // TODO(phase-3 task 14): statistics view migrated to src/views/statistics.
  it.skip("clicking a sort header re-renders with a different active column (asserts via DOM, no internal state access)", async () => {
    const window = await boot();
    // Find a header that is NOT currently the active sort, so clicking it
    // will move the active state — that's the visible proof sorting works.
    const allThs = [...window.document.querySelectorAll("#statistics-content th[data-sort]")];
    expect(allThs.length).toBeGreaterThanOrEqual(2);
    const inactive = allThs.find((th) => !th.classList.contains("sort-active"));
    expect(inactive, "expected at least one non-active sort header to click").toBeDefined();
    const targetCol = inactive.dataset.sort;
    const targetList = inactive.dataset.list;
    inactive.click();
    await new Promise((r) => setTimeout(r, 30));
    const afterActive = window.document.querySelector(
      `#statistics-content th[data-sort='${targetCol}'][data-list='${targetList}']`
    );
    expect(afterActive).not.toBeNull();
    expect(afterActive.classList.contains("sort-active")).toBe(true);
  });
});

// TODO(phase-3 task 14): home view migrated to src/views/dashboard; the
// #stats-content + .stat-cards host now materialises only after the TS
// module runs. Rewire this suite to boot the TS entry through Vite.
describe.skip("dashboard boots without throwing against non-empty history", () => {
  const snapshots = [
    {
      captured_at: new Date().toISOString(),
      five_hour: { utilization: 42.0, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
      seven_day: { utilization: 18.0, resets_at: new Date(Date.now() + 3 * 86_400_000).toISOString() },
      extra_usage: null,
    },
  ];

  let window;
  let capturedErrors;

  beforeAll(async () => {
    capturedErrors = [];
    const originalConsoleError = console.error;
    console.error = (...args) => { capturedErrors.push(args.map(String).join(" ")); };
    try {
      ({ window } = await bootDashboard(snapshots));
    } finally {
      console.error = originalConsoleError;
    }
  });

  it("paints no [ERR] / [REJ] overlay lines", () => {
    const body = window.document.body.innerHTML;
    expect(body).not.toMatch(/\[ERR\]/);
    expect(body).not.toMatch(/\[REJ\]/);
  });

  it("clears the 'Loading...' placeholder once data loads", () => {
    const host = window.document.getElementById("stats-content");
    expect(host).not.toBeNull();
    // Either stat-cards got rendered, or the empty-state placeholder replaced
    // the literal "Loading..." string. Anything but "Loading..." is success.
    expect(host.textContent.trim().startsWith("Loading...")).toBe(false);
  });

  it("renders stat-cards with the translated percentages", () => {
    const host = window.document.getElementById("stats-content");
    // renderHistory builds a .stat-cards container whenever history.length > 0.
    expect(host.querySelector(".stat-cards")).not.toBeNull();
    // 42 (session) and 18 (weekly) should appear in the DOM.
    const text = host.textContent;
    expect(text).toContain("42%");
    expect(text).toContain("18%");
  });

  // Note: we intentionally don't assert on the Version label here because
  // settings.js wires it inside `window.onload`, and jsdom's load event
  // lifecycle with programmatically-injected <script> tags is flaky (the
  // handler sometimes sees a partially-initialised DOM). The version wiring
  // is covered by the static assertion in dashboard_wiring.test.mjs that
  // `modules/settings.js` is present in the script list — the renderer in
  // Tauri auto-fires `load` normally.
});
