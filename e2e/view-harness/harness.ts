// Browser view-harness (iterate-it P6, 2026-07-12).
//
// Runs ONE view of the SPA in a plain Playwright/Chromium browser against a
// mocked backend - NO Tauri process, NO daemon, NO cargo build. This never
// touches Joe's live app/daemon, so testing a view can't bounce a chat he's
// actively using (the whole reason this exists).
//
// Mechanism: the frontend funnels every backend request through
// `getTransport()` (src/shared/transport.ts), which picks TauriTransport iff
// `window.__TAURI__` is present. We install a FAKE `window.__TAURI__` via
// `page.addInitScript` (runs pre-navigation, before main.ts's first invoke),
// so:
//   - TauriTransport consumes our fake `core.invoke` / `event.listen` as-is
//     (zero production-code changes), and
//   - `isTauri()` -> true / `isRemote()` -> false, so boot mounts the real
//     DESKTOP view instead of the phone pairing-token gate.
//
// `mockInvoke` is keyed by command name and returns a Promise (call sites chain
// `.catch()` directly on it). An UNMOCKED command REJECTS loudly - a gap shows
// up as a red test, never a false-green pass. That throw is what surfaces a
// missing boot-seed command, so keep it.
//
// Events: `mockListen` registers callbacks so app code can subscribe without
// crashing; nothing currently drives them (no spec pushes a backend event
// mid-run yet).

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { test, type Locator, type Page } from "@playwright/test";
import type { Instance } from "../../src/types/ipc.generated";

export type Entry = "index" | "overlay";

/** Command -> canned response. Values are JSON-serialized into the browser, so
 *  they must be plain data (no functions). Merge a view's own commands on top
 *  of the boot seed via {@link mountView}'s `invoke` option. */
export type InvokeMap = Record<string, unknown>;

const HARNESS_ORIGIN = "http://localhost:4420";

// Minimum command seeds for each entry's boot sequence to COMPLETE without an
// unmocked-command rejection. Verified against src/shared/boot.ts (index) and
// src/overlay-main.ts (overlay) on 2026-07-12. Re-verify when boot changes -
// this list drifts by design; the loud reject is the tripwire.
const BOOT_SEED: Record<Entry, InvokeMap> = {
  index: {
    frontend_ready: null,
    // getUsageHistory() -> get_history; [] keeps runDeadPathCheck an early-return.
    get_history: [],
    get_token_history: [],
    get_active_sessions: [],
    // A settings object (not null) so applyThemeFromSettings runs; coerceSettings
    // fills the rest.
    get_settings: { theme: "void" },
    fetch_available_models: [],
    // registered:true => the hook-consent modal never pops.
    get_hook_registration_state: { registered: true, declined: false, port: 0 },
    // null => the legacy-obsidian import banner is skipped.
    import_legacy_obsidian_config: null,
  },
  overlay: {
    frontend_ready: null,
    get_settings: { theme: "void" },
  },
};

/**
 * Installed into the page BEFORE any app script runs. Standalone (no outer
 * scope) so Playwright can serialize it. `seed` carries the merged InvokeMap.
 */
function installMockTauri(seed: { invokeMap: InvokeMap }): void {
  const invokeMap = seed.invokeMap;
  const listeners = new Map<string, Set<(e: { payload: unknown }) => void>>();

  const w = window as unknown as Record<string, unknown>;
  w.__ccInvokeCalls = [];

  (window as { __TAURI__?: unknown }).__TAURI__ = {
    core: {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        (w.__ccInvokeCalls as unknown[]).push({ cmd, args });
        if (Object.prototype.hasOwnProperty.call(invokeMap, cmd)) {
          return Promise.resolve(invokeMap[cmd]);
        }
        return Promise.reject(
          new Error(`[view-harness] unmocked command: ${cmd}`),
        );
      },
    },
    event: {
      listen: (event: string, cb: (e: { payload: unknown }) => void) => {
        let set = listeners.get(event);
        if (!set) {
          set = new Set();
          listeners.set(event, set);
        }
        set.add(cb);
        return Promise.resolve(() => set!.delete(cb));
      },
    },
  };

  // Belt-and-suspenders: if a future refactor moves the boot gate off
  // `window.__TAURI__` onto a token check, this keeps the pairing gate away.
  try {
    localStorage.setItem("rc_token", "test-token");
  } catch {
    /* storage disabled - fake __TAURI__ alone still passes the current gate */
  }
}

export interface MountOptions {
  /** Route hash to open (e.g. "dashboard", "schedule"). Omit for the default. */
  view?: string;
  /** Which HTML entry to load. Default "index" (main.ts + full router). */
  entry?: Entry;
  /** View-specific command responses, merged over the boot seed. */
  invoke?: InvokeMap;
}

/**
 * Install the mock backend and navigate to the view. After this resolves the
 * SPA has booted against the mock; assert on the rendered DOM as usual.
 */
export async function mountView(page: Page, opts: MountOptions = {}): Promise<void> {
  const entry: Entry = opts.entry ?? "index";
  const invokeMap: InvokeMap = { ...BOOT_SEED[entry], ...(opts.invoke ?? {}) };

  await page.addInitScript(installMockTauri, { invokeMap });

  const hash = opts.view ? `#${opts.view}` : "";
  await page.goto(`${HARNESS_ORIGIN}/${entry}.html${hash}`);
}

/** Read the commands the page has invoked so far (for call-shape asserts). */
export async function invokeCalls(page: Page): Promise<Array<{ cmd: string; args?: unknown }>> {
  return page.evaluate(
    () => (window as unknown as { __ccInvokeCalls: Array<{ cmd: string; args?: unknown }> }).__ccInvokeCalls,
  );
}

// Shared sidebar-list fixture (todo 720): was pasted into 16 specs as a local
// `BASE_INVOKE` + `instance()` + `mountSessions()` trio, so one new `Instance`
// field meant editing every copy or leaving most on a stale shape.

/** Commands the sessions view's boot + a mounted session pane need. A superset
 *  of what any one spec calls - unused keys in an InvokeMap are inert, never
 *  invoked, so this is safe to share even for specs that only need a subset. */
export const SESSIONS_BASE_INVOKE: InvokeMap = {
  get_accounts_setup_prompt_state: { shouldShow: false },
  get_usage_map: {},
  get_skill_usage_week: { entries: [], total_sessions: 0 },
  poll_now: null,
  list_projects: [],
  resolve_whitelist_characters: [],
  probe_models_availability: [],
  list_accounts: [],
  list_scheduled_messages: [],
  list_session_characters: {},
  watch_session_transcript: null,
  unwatch_session_transcript: null,
  session_live_cwd: null,
  get_git_info: null,
  get_session_counts: null,
  get_context_status: null,
  get_session_drain: null,
  list_pending_prompts: [],
  get_chat_config: null,
};

const SESSION_DEFAULTS: Instance = {
  session_id: "s1", pid: 100, cwd: "C:/Projects/alpha",
  project_id: "p1", kind: "interactive", is_remote: false,
  started_at: "2026-08-01T10:00:00Z", transcript_path: null, bridge_session_id: null,
  name: "Alpha chat", ended_at: null, end_reason: null,
  busy: false, model: "claude-opus-5", effort: "high", awaiting: "done",
  autopilot: false, jarvis: false, worker_of: null, closing: false,
  account_id: null, rate_limited_resets_at: null, rate_limited_type: null,
  frozen: false, auto_frozen: false, held_count: 0, local_task_running: false,
};

/** Typed against the real `Instance` (src/types/ipc.generated.ts), so a field
 *  added/renamed there fails typecheck here instead of silently rotting every
 *  spec's copy-pasted fixture - the main point of todo 720. */
export function sessionInstance(over: Partial<Instance> = {}): Instance {
  return { ...SESSION_DEFAULTS, ...over };
}

/** Mounts the sessions view with a given row set. `rowStyle` is opt-in: pass
 *  it to pin `classic`/`portrait` via localStorage before nav, or omit it to
 *  leave localStorage untouched, which resolves to the app's real default
 *  ("portrait", row-style.ts) - several specs depend on that exact fallback. */
export async function mountSessionsList(
  page: Page,
  sessions: Instance[],
  rowStyle?: "classic" | "portrait",
): Promise<void> {
  if (rowStyle) {
    await page.addInitScript((v) => localStorage.setItem("cc_chat_row_style", v), rowStyle);
  }
  await mountView(page, {
    view: "sessions",
    invoke: { ...SESSIONS_BASE_INVOKE, list_instances: sessions, get_active_sessions: sessions },
  });
  // Unscoped `li`, not `li[data-session-id]`: a session inside the (default-
  // collapsed) Closing segment renders no visible session row at all, only
  // the group-header `li` - see close-teardown's torn-down-session case.
  await page.locator("#sessions-list li").first().waitFor();
}

export interface SessionsLayoutOptions {
  /** Add the `.view-header` band (back button, title, dial host, kebab). */
  header?: boolean;
  /** Mount the mobile pager over the layout. Implies `header`. */
  pager?: boolean;
  /** Open the docked preview panel instead of leaving it closed. */
  openPanel?: boolean;
}

/** Rebuilds `.sessions-layout` from template.ts markup and docks a preview panel
 *  into it: the sessions view is not the default route and booting it needs a
 *  long tail of mocks. The stylesheet is global, so the real cascade applies.
 *  Call {@link mountView} (with `list_previews` mocked) first. */
export async function mountSessionsLayout(page: Page, opts: SessionsLayoutOptions = {}): Promise<void> {
  const cfg = {
    header: (opts.header ?? false) || (opts.pager ?? false),
    pager: opts.pager ?? false,
    openPanel: opts.openPanel ?? false,
  };
  await page.evaluate(async (o) => {
    const pv = await import("/views/sessions/preview-panel.ts");
    document.querySelector("#preview-panel-host")?.remove();

    const view = document.createElement("div");
    view.className = "view view-sessions";
    if (o.header) view.setAttribute("data-mobile-pane", "chat");
    view.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column;z-index:9999";
    const header = o.header
      ? `<div class="view-header">
        <button class="icon-btn sessions-back" id="sessionsBackBtn"><i class="ph ph-arrow-left"></i></button>
        <h2>Chats</h2>
        <span id="usage-dial-host"></span>
        <button class="icon-btn more-btn" id="viewMoreBtn"><i class="ph ph-dots-three-vertical"></i></button>
      </div>`
      : "";
    view.innerHTML = `${header}
      <div class="view-body sessions-layout" style="flex:1">
        <aside class="sessions-sidebar"></aside>
        <main class="session-pane" id="session-pane"></main>
        <div id="preview-panel-host" hidden></div>
      </div>
      ${o.pager ? `<div id="mobile-tabbar-host"></div>` : ""}`;
    document.body.appendChild(view);

    const host = view.querySelector<HTMLElement>("#preview-panel-host")!;
    const controller = pv.renderPreview(host, { mode: "panel" });
    controller.setSessionScope("sess-1");
    if (o.openPanel) controller.open();
    if (o.pager) {
      const pager = await import("/views/sessions/mobile-pager.ts");
      const layout = view.querySelector<HTMLElement>(".sessions-layout")!;
      pager.mountMobilePager(view.querySelector<HTMLElement>("#mobile-tabbar-host")!, layout, controller);
    }
  }, cfg);
}

/** `<pid>-<procStart-ticks>`, the id `close/rename-session.ps1 -GetId` prints:
 *  the ~/.claude/sessions record whose sessionId matches this session. */
function sessionShotId(): string {
  const pinned = process.env.CC_SHOT_ID;
  if (pinned) return pinned;
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  const dir = path.join(homedir(), ".claude", "sessions");
  if (sid && existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as {
          sessionId?: string; pid?: number; procStart?: string;
        };
        if (rec.sessionId === sid && rec.pid && rec.procStart) return `${rec.pid}-${rec.procStart}`;
      } catch {
        /* a session file mid-write - skip it */
      }
    }
  }
  // Outside a Claude session (or env var unset): one bucket /disk-doctor can still age out.
  return "no-session";
}

/** `config.rootDir` is the testDir (e2e/view-harness), so climb to the directory
 *  holding playwright.config.ts, which is the repo root. */
function repoRoot(): string {
  let dir: string;
  try {
    dir = test.info().config.rootDir;
  } catch {
    dir = process.cwd();
  }
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, "playwright.config.ts"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}

/** Write a PNG of a mounted view (or one element) to
 *  `.for_bepy/screenshots/<session-id>/<label>.png`, so showing Joe a visual
 *  change needs no throwaway spec. Returns and logs the path. */
export async function capture(
  target: Page | Locator,
  label: string,
  opts: { fullPage?: boolean } = {},
): Promise<string> {
  const dir = path.join(repoRoot(), ".for_bepy", "screenshots", sessionShotId());
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${label.replace(/[^a-z0-9._-]+/gi, "-")}.png`);
  if ("setViewportSize" in target) {
    await target.screenshot({ path: file, fullPage: opts.fullPage ?? false });
  } else {
    await target.screenshot({ path: file });
  }
  console.log(`[capture] ${file}`);
  return file;
}
