import "./styles/tokens.css";
// Kit settings layer (neutral --color-* + .kit-* widget CSS) + the 4 palettes
// (2D [data-theme][data-mode]). Imported BEFORE base.css/widgets.css so
// claude_usage's own base element rules (e.g. body font) win over the kit reset.
import "../vendor/tauri_kit/frontend/settings/styles.css";
import "../vendor/tauri_kit/frontend/settings/palettes/sirbepy-default.css";
import "./styles/base.css";
import "./styles/widgets.css";
import "./styles/motion.css";

import { mountRouter, registerView } from "./router";
import { initBoot, applySettingsToDocument } from "./shared/boot";
import { api } from "./shared/api";
import { ensureRemoteToken } from "./shared/remote-gate";
import { isRemote } from "./shared/transport";
import { showView } from "./shared/navigation";
import { closeSidemenu } from "./shared/sidemenu";
import { initBackButton, registerOverlayBack } from "./shared/back-button";
import { installPermissionModalListener, setSidebarRerenderHook } from "./views/sessions/permission-modal";
import { renderSidebar } from "./views/sessions/sidebar";
import { installExternalLinkInterceptor } from "./shared/external-links";
import { invoke } from "./shared/ipc";
import { setAuthorTagResolver } from "./shared/chat/author-tag-source";
import { characterForSessionId } from "./views/sessions/session-characters";
import { state as sessionsState } from "./views/sessions/state";
import { setupRemoteVoicelines } from "./shared/remote-voiceline";
import { setupNewsBadgeAndNotifications, setupScheduleMissedPopup, setupScheduledFireToast } from "./shared/notification-listeners";
import { initWindowTitlebar } from "./shared/window-titlebar";
import { initCursorAutohide } from "./shared/cursor-autohide";
import { installE2eSeams } from "./boot/e2e-seams";
import { installPrintBlock } from "./shared/print-block";
import { detachedSessionFromHash, previewSessionFromHash, codeSessionFromHash } from "./boot/window-mode-hash";
import "./missed-panel.css";

// Test-build banner: in dev (`cargo tauri dev` / the vite dev server) paint a
// slim marker strip at the top so a test build is never mistaken for a real
// install. `import.meta.env.DEV` is false under `vite build`, so this block is
// stripped from production bundles.
if (import.meta.env.DEV) {
  const paintTestBanner = (): void => {
    if (document.getElementById("test-build-banner")) return;
    const bar = document.createElement("div");
    bar.id = "test-build-banner";
    bar.textContent = "TEST BUILD";
    bar.style.cssText = [
      "position:fixed", "top:0", "left:0", "right:0", "height:16px",
      "text-align:center", "font:600 10px/16px 'DM Sans',sans-serif",
      "letter-spacing:1.5px", "color:#1a1400", "background:#f5b301",
      "z-index:2147483647", "pointer-events:none", "user-select:none",
    ].join(";");
    document.body.appendChild(bar);
  };
  if (document.body) paintTestBanner();
  else document.addEventListener("DOMContentLoaded", paintTestBanner);
}

// wdio/view-harness e2e test seams (window.__injectEdit/__injectNews/
// __setSelectedSession/__injectQuestion/__openNewChatModal/__startNewSession/
// __setBusy) - see src/boot/e2e-seams.ts for the per-seam rationale.
// `installE2eSeams` gates its own body on `import.meta.env.DEV`, so this call
// is unconditional here but installs nothing in a `vite build` production
// bundle.
installE2eSeams();
installPrintBlock();

// Route-level dynamic imports (todo 187): each view's chunk loads only when
// its route mounts, so windows stop parsing code they never visit. Cast at
// this one boundary since RenderFn wants Promise<void>|Promise<()=>void>,
// not TS's inferred Promise<void|(()=>void)> from a plain `.then`.
type ViewRenderFn = (root: HTMLElement) => void | Promise<void> | (() => void) | Promise<() => void>;
function lazyView(loader: () => Promise<Record<string, unknown>>, fnName: string): (root: HTMLElement) => Promise<void> | Promise<() => void> {
  return (root) => loader().then((m) => (m[fnName] as ViewRenderFn)(root)) as unknown as Promise<void> | Promise<() => void>;
}

registerView("dashboard", lazyView(() => import("./views/dashboard/dashboard"), "renderDashboard"));
registerView("sessions", lazyView(() => import("./views/sessions/sessions"), "renderSessionsView"));
registerView("history", lazyView(() => import("./views/history/history"), "renderHistoryView"));
registerView("schedule", lazyView(() => import("./views/schedule/schedule"), "renderScheduleView"));
registerView("projects", lazyView(() => import("./views/projects/projects"), "renderProjectsView"));
registerView("characters", lazyView(() => import("./views/characters/characters"), "renderCharactersView"));
registerView("character-detail", lazyView(() => import("./views/characters/character-detail"), "renderCharacterDetailView"));
registerView("news", lazyView(() => import("./views/news/news"), "renderNewsView"));
registerView("project-detail", lazyView(() => import("./views/project-detail/project-detail"), "renderProjectDetailView"));
registerView("project-character-pick", lazyView(() => import("./views/project-detail/subviews/character-pick/character-pick"), "renderCharacterPickView"));
registerView("project-automation", lazyView(() => import("./views/project-detail/subviews/automation/automation"), "renderAutomationView"));
registerView("project-folder-mapping", lazyView(() => import("./views/project-detail/subviews/folder-mapping/folder-mapping"), "renderFolderMappingView"));
registerView("project-sessions", lazyView(() => import("./views/project-detail/subviews/sessions-list/sessions-list"), "renderSessionsListView"));
registerView("session-detail", lazyView(() => import("./views/session-detail/session-detail"), "renderSessionDetailView"));
registerView("settings", lazyView(() => import("./views/settings/settings"), "renderSettingsView"));
registerView("skill-detail", lazyView(() => import("./views/skill-detail/skill-detail"), "renderSkillDetailView"));
registerView("skills", lazyView(() => import("./views/skills/skills"), "renderSkillsView"));
registerView("settings-appearance", lazyView(() => import("./views/settings/subviews/appearance/appearance"), "renderAppearanceView"));
registerView("settings-notifications", lazyView(() => import("./views/settings/subviews/notifications/notifications"), "renderNotificationsView"));
registerView("settings-chat-defaults", lazyView(() => import("./views/settings/subviews/chat-defaults/chat-defaults"), "renderChatDefaultsView"));
registerView("settings-characters", lazyView(() => import("./views/settings/subviews/characters/characters"), "renderCharactersSettingsView"));
registerView("settings-system", lazyView(() => import("./views/settings/subviews/system/system"), "renderSystemView"));
registerView("settings-permissions", lazyView(() => import("./views/settings/subviews/permissions/permissions"), "renderPermissionsView"));
registerView("settings-statusline", lazyView(() => import("./views/settings/subviews/statusline/statusline"), "renderStatuslineView"));
registerView("settings-about", lazyView(() => import("./views/settings/subviews/about/about"), "renderAboutView"));
registerView("settings-remote-access", lazyView(() => import("./views/settings/subviews/remote-access/remote-access"), "renderRemoteAccessView"));
registerView("settings-accounts", lazyView(() => import("./views/settings/subviews/accounts/accounts"), "renderAccountsSettingsView"));

const app = document.getElementById("app");
if (!app) {
  throw new Error("Root element #app not found in index.html");
}

// Signal to the Rust boot watchdog that the webview loaded successfully.
// If this never fires within ~6s, the watchdog reloads the window. Recovers
// from WebView2 "can't reach this page" caused by an unreachable start URL
// at boot (autostart racing the network / vite dev server).
void invoke("frontend_ready").catch(() => {});

// Heartbeat for the renderer-crash watchdog. "main"-only: detached windows
// (chats/schedule) share this entry point and would otherwise keep the
// shared, unscoped ping timestamp fresh forever, masking a dead "main".
const currentWindowLabel = (window as unknown as {
  __TAURI__?: { window?: { getCurrentWindow: () => { label: string } } };
}).__TAURI__?.window?.getCurrentWindow().label;
if (currentWindowLabel === "main") {
  // Paint-liveness counter: JS can keep running (so pings keep firing) while
  // WebView2's compositor stops presenting frames. rAF only fires on an
  // actual paint, so a frozen count here (while pings keep arriving) is the
  // watchdog's signal for that distinct failure mode. `frontend_ping` only
  // checks that the tick changed since the last ping, so one frame armed per
  // ping proves the same thing a free-running loop did. `rafPending` stops
  // hidden-window pings (rAF never fires while hidden) from stacking frames.
  let rafTick = 0;
  let rafPending = false;
  function armRafTick(): void {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; rafTick++; });
  }
  armRafTick();

  function pingFrontend(): void {
    if (document.visibilityState === "visible") void invoke("frontend_ping", { rafTick }).catch(() => {});
    armRafTick();
  }
  pingFrontend();
  setInterval(pingFrontend, 10_000);
  document.addEventListener("visibilitychange", pingFrontend);
}

installExternalLinkInterceptor();
initWindowTitlebar();
initCursorAutohide();

if (new URLSearchParams(window.location.search).get("chatswindow") === "1") {
  document.body.classList.add("chats-window-mode");
  // The sidemenu has no purpose in the chats window. Drop the DOM entirely
  // so the initial CSS transition can't briefly animate it in during paint.
  document.getElementById("sidemenu")?.remove();
  document.getElementById("sidemenuBackdrop")?.remove();
}

// Standalone Schedule window: backend opens a new window at
// `index.html?schedulewindow=1#schedule`. Render the calendar solo (no router,
// no sidemenu, no boot) - it's single-purpose, like the detached-session window.
const isScheduleWindow = new URLSearchParams(window.location.search).get("schedulewindow") === "1";
if (isScheduleWindow) {
  document.body.classList.add("schedule-window-mode");
  document.getElementById("sidemenu")?.remove();
  document.getElementById("sidemenuBackdrop")?.remove();
}

// Standalone Preview pop-out window (todo 290), same solo-render shape as Schedule above.
const previewSessionId = previewSessionFromHash();
if (previewSessionId) {
  document.body.classList.add("preview-window-mode");
  document.getElementById("sidemenu")?.remove();
  document.getElementById("sidemenuBackdrop")?.remove();
}

const codeSessionId = codeSessionFromHash();
if (codeSessionId) {
  document.body.classList.add("code-window-mode");
  document.getElementById("sidemenu")?.remove();
  document.getElementById("sidemenuBackdrop")?.remove();
}

// Opt out of the back-forward cache: bfcache-freezing this tab while
// Android's native file picker is open on top of it drops the picker's
// result on return with no error - the mobile "picker opens, nothing
// attaches" bug. A no-op unload listener is the standard bfcache opt-out.
window.addEventListener("unload", () => {});

// Browser-only token gate: shows a full-screen form when no bearer token is
// stored. Complete NO-OP inside the Tauri webview (window.__TAURI__ present).
// Halt boot when the gate rendered its form so no commands are sent without auth.
const detachedSessionId = detachedSessionFromHash();
void (async () => {
if (!await ensureRemoteToken()) {
  // Gate rendered - boot stops here. The form's submit handler reloads the page.
} else {
// Install the permission/question relay listener once per window, regardless
// of whether this is the main window or a detached single-session window. The
// listener is a no-op until either a permission-requested or question-requested
// Tauri event fires from the hooks server. Deliberately placed AFTER the token
// gate above: hydrateAutoAccept()/startRemotePromptPoll() (inside this call)
// fire an RPC immediately, and on the phone client that raced ahead of the
// token being stored, 401ing and tripping handleAuthFailure()'s token-clear +
// reload on every single load - an inescapable reload loop (the "page
// refreshing constantly" bug).
installPermissionModalListener();
// One-time statusline rows rewrite; a no-op on every boot after the first.
void import("./views/sessions/session-statusbar-helpers").then((m) => m.migrateStatuslineToV2());
// Let the permission relay re-render the sidebar when it parks/clears a
// backgrounded chat's prompt (injected to avoid a static import cycle).
setSidebarRerenderHook(() => {
  const listEl = document
    .querySelector<HTMLElement>(".view-sessions")
    ?.querySelector<HTMLElement>("#sessions-list");
  if (listEl) renderSidebar(listEl);
});
// Same injection reason as above: chat-transforms renders the AI-authored tag
// but must not static-import view state. Runs per window realm, so the chats
// window gets its own registration off this same entry point.
setAuthorTagResolver((sessionId) => ({
  charId: characterForSessionId(sessionId),
  cwd: sessionsState.sessions.find((s) => s.session_id === sessionId)?.cwd ?? null,
}));
if (detachedSessionId) {
  document.body.classList.add("detached-mode");
  // Hide all static legacy views from index.html so only #app renders.
  document.querySelectorAll<HTMLElement>("body > .view").forEach((el) => el.classList.add("hidden"));
  // Skip mountRouter + initBoot's live-subscription wiring (this window is
  // single-purpose), but still fetch settings once so theme/background match
  // the rest of the app instead of index.html's static defaults.
  void api.getSettings().then((s) => { if (s) applySettingsToDocument(s); });
  void import("./views/sessions/sessions").then((m) => m.renderDetachedSession(app, detachedSessionId));
} else if (isScheduleWindow) {
  // Solo calendar render. Hide the static legacy views and mount the schedule
  // view straight into #app; no router, no boot (this window only shows the
  // calendar and cross-navigates to the Chats window on item click).
  document.querySelectorAll<HTMLElement>("body > .view").forEach((el) => el.classList.add("hidden"));
  void import("./views/schedule/schedule").then((m) => m.renderScheduleView(app));
} else if (codeSessionId) {
  // Solo Code mode render; no router, no sidemenu, no boot.
  document.querySelectorAll<HTMLElement>("body > .view").forEach((el) => el.classList.add("hidden"));
  void api.getSettings().then((s) => { if (s) applySettingsToDocument(s); });
  void import("./views/sessions/code-mode/popout").then((m) => m.mountCodeWindow(app, codeSessionId));
} else if (previewSessionId) {
  // Solo preview render; no router, no sidemenu, no boot.
  document.querySelectorAll<HTMLElement>("body > .view").forEach((el) => el.classList.add("hidden"));
  void import("./views/sessions/preview-panel").then((m) => m.mountPreviewWindow(app, previewSessionId));
} else {
  mountRouter(app);
  initBoot();

  // Phone PWA: trap the hardware back button so it navigates within the app
  // instead of closing it. The mobile chat pane is a non-view overlay (a CSS
  // attribute, not a route), so register its back affordance here: back from an
  // open chat returns to the session list before back starts stepping views.
  if (isRemote()) {
    initBackButton();
    registerOverlayBack(() => {
      const el = document.querySelector(".view-sessions");
      if (el?.getAttribute("data-mobile-pane") === "chat") {
        el.setAttribute("data-mobile-pane", "list");
        return true;
      }
      return false;
    });
  }

  if (!document.body.classList.contains("chats-window-mode")) {
    void window.__TAURI__?.event?.listen?.("navigate-to-dashboard", () => {
      void (window as unknown as { navigateTo: (n: string) => Promise<void> }).navigateTo("dashboard");
    });

    // Cross-window jump from the chats window's "Add account" link: navigate
    // to the accounts settings page in the dashboard window instead of the
    // chats window's own router (see navigate-to-project comment below).
    void window.__TAURI__?.event?.listen?.("navigate-to-settings-accounts", () => {
      void (window as unknown as { navigateTo: (n: string) => Promise<void> }).navigateTo("settings-accounts");
    });

    // Cross-window jump from the chats window's per-chat menu: navigate to
    // a specific project's detail page in the main dashboard.
    void window.__TAURI__?.event?.listen?.("navigate-to-project", async (e: { payload: string }) => {
      const cwd = e.payload;
      if (!cwd) return;
      const { openProjectDetail } = await import("./shared/navigation");
      openProjectDetail(cwd);
    });

    // Cross-window jump from a floating-overlay card click: show the dashboard
    // focused on that account.
    void window.__TAURI__?.event?.listen?.("navigate-to-account", async (e: { payload: string }) => {
      const accountId = e.payload;
      if (!accountId) return;
      const { focusDashboardAccount } = await import("./views/dashboard/dashboard");
      focusDashboardAccount(accountId);
      await (window as unknown as { navigateTo: (n: string) => Promise<void> }).navigateTo("dashboard");
    });
  } else {
    // Chats window: honour "Open in chats" and "new chat" requests from the
    // main window. Fresh-created window drains the stashed request on boot;
    // an already-open window catches the live event.
    void invoke<[string, string] | null>("take_pending_chat_open").then((p) => {
      if (p) void applyChatOpenRequest(p[0], p[1]);
    }).catch(() => {});
    void invoke<PendingNewChatPayload | null>("take_pending_new_chat").then((p) => {
      if (p) void applyChatNewRequest(p);
    }).catch(() => {});
    const ev = window.__TAURI__?.event;
    if (ev?.listen) {
      void ev.listen<{ sessionId: string; mode: string }>(
        "chats-open-session",
        (e) => void applyChatOpenRequest(e.payload?.sessionId, e.payload?.mode),
      );
      void ev.listen<PendingNewChatPayload>(
        "chats-new-chat",
        (e) => void applyChatNewRequest(e.payload),
      );
    }
  }

  // Sidemenu wiring (ported from legacy dashboard.js). Burger buttons inside
  // migrated views wire openSidemenu on render; these bindings cover the
  // backdrop + nav-item clicks which live in the static index.html.
  const backdrop = document.getElementById("sidemenuBackdrop");
  if (backdrop) backdrop.onclick = closeSidemenu;

  document.querySelectorAll<HTMLElement>(".sidemenu-nav-item").forEach((item) => {
    item.onclick = () => {
      const view = item.dataset.view;
      // Jarvis (todo 272) has no in-app view at all - it lives ONLY in its own
      // dedicated Tauri window (see open_jarvis_window), same "own window, not
      // a route" shape as Schedule below. No browser/remote fallback route
      // exists to fall back to (the design's phone cockpit deliberately never
      // surfaces Jarvis), so this is a no-op outside Tauri.
      if (item.dataset.action === "jarvis") {
        if (window.__TAURI__) {
          void invoke("open_jarvis_window").catch((err) =>
            console.error("[nav] open_jarvis_window failed", err),
          );
        }
        closeSidemenu();
        return;
      }
      // Schedule now lives in its own window (the calendar). Open that instead
      // of routing in-place; fall back to the in-app route in the browser/remote
      // build where there's no separate-window concept.
      if (view === "schedule" && window.__TAURI__) {
        void invoke("open_schedule_window").catch((err) =>
          console.error("[nav] open_schedule_window failed", err),
        );
        closeSidemenu();
        return;
      }
      if (view) showView(view);
      closeSidemenu();
    };
  });

  if (!isRemote()) {
    const chatsNavItem = document.getElementById("sm-chats");
    if (chatsNavItem) chatsNavItem.style.display = "none";
  }

  // Jarvis is desktop-only (own dedicated window; no remote/phone route at
  // all - see the click handler above and the design's binding decision to
  // keep Jarvis out of the phone cockpit entirely). Hide the nav item on the
  // remote/phone build so it's not a dead button there.
  if (isRemote()) {
    const jarvisNavItem = document.getElementById("sm-jarvis");
    if (jarvisNavItem) jarvisNavItem.style.display = "none";
  }

  // Static legacy back buttons still present in index.html.
  const graphBackBtn = document.getElementById("graphDetailBackBtn");
  if (graphBackBtn) graphBackBtn.onclick = () => showView("dashboard");

  document.querySelectorAll<HTMLElement>("#view-settings-sync .back-to-settings").forEach((btn) => {
    btn.onclick = () => showView("settings");
  });

  setupNewsBadgeAndNotifications();
  setupScheduleMissedPopup();
  setupScheduledFireToast();
  setupRemoteVoicelines();
}
}
})();

/**
 * Surface a session in the chats window. "live" selects the running session in
 * the Sessions view; "history" opens it read-only in the History view. Both
 * route through the same select-on-mount queues the in-window flows use.
 */
async function applyChatOpenRequest(sessionId: string | undefined, mode: string | undefined): Promise<void> {
  if (!sessionId) return;
  if (mode === "history") {
    const { queueHistorySelect } = await import("./views/history/history");
    queueHistorySelect(sessionId);
    showView("history");
  } else {
    const { queueSessionSelect } = await import("./views/sessions/sessions");
    queueSessionSelect(sessionId);
    showView("sessions");
  }
}

/** Shape of the `open_chats_new_chat`/`take_pending_new_chat` IPC payload
 * (Rust's `ipc::window::PendingNewChat`, serde camelCase). Carries the full
 * model/effort modal `SessionConfig` - not just model/effort - so account,
 * auto-accept, and character picks survive the Chats-window "+" round trip
 * (ai_todo 163). */
interface PendingNewChatPayload {
  projectPath?: string;
  projectName?: string;
  model?: string;
  effort?: string;
  accountId?: string | null;
  autoAccept?: boolean;
  characterId?: string | null;
}

async function applyChatNewRequest(payload: PendingNewChatPayload | undefined): Promise<void> {
  if (!payload?.projectPath) return;
  const { queueNewChat } = await import("./views/sessions/sessions");
  queueNewChat(
    { path: payload.projectPath, name: payload.projectName ?? payload.projectPath },
    {
      model: payload.model ?? "",
      effort: payload.effort ?? "",
      accountId: payload.accountId ?? null,
      autoAccept: payload.autoAccept,
      characterId: payload.characterId ?? null,
    },
  );
  showView("sessions");
}

// Register the PWA service worker in browser-only mode (phone/remote client).
// Complete no-op in the Tauri webview: __TAURI__ is present there and SW
// registration would be irrelevant anyway (webview doesn't install PWAs).
if (typeof window !== "undefined" && !window.__TAURI__ && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js");
}
