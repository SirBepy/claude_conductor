import "./styles/tokens.css";
// Kit settings layer (neutral --color-* + .kit-* widget CSS) + the 4 palettes
// (2D [data-theme][data-mode]). Imported BEFORE base.css/widgets.css so
// claude_usage's own base element rules (e.g. body font) win over the kit reset.
import "../vendor/tauri_kit/frontend/settings/styles.css";
import "../vendor/tauri_kit/frontend/settings/palettes/sirbepy-default.css";
import "./styles/base.css";
import "./styles/widgets.css";

import { mountRouter, registerView } from "./router";
import { renderDashboard } from "./views/dashboard/dashboard";
import { renderSessionsView, renderDetachedSession, queueSessionSelect, queueNewChat } from "./views/sessions/sessions";
import { renderHistoryView, queueHistorySelect } from "./views/history/history";
import { renderScheduleView } from "./views/schedule/schedule";
import { renderProjectsView } from "./views/projects/projects";
import { renderCharactersView } from "./views/characters/characters";
import { renderCharacterDetailView } from "./views/characters/character-detail";
import { renderNewsView } from "./views/news/news";
import { renderProjectDetailView } from "./views/project-detail/project-detail";
import { renderCharacterPickView } from "./views/project-detail/subviews/character-pick/character-pick";
import { renderAutomationView } from "./views/project-detail/subviews/automation/automation";
import { renderFolderMappingView } from "./views/project-detail/subviews/folder-mapping/folder-mapping";
import { renderSessionsListView } from "./views/project-detail/subviews/sessions-list/sessions-list";
import { renderSessionDetailView } from "./views/session-detail/session-detail";
import { renderSettingsView } from "./views/settings/settings";
import { renderSkillDetailView } from "./views/skill-detail/skill-detail";
import { renderSkillsView } from "./views/skills/skills";
import { renderAppearanceView } from "./views/settings/subviews/appearance/appearance";
import { renderNotificationsView } from "./views/settings/subviews/notifications/notifications";
import { renderChatDefaultsView } from "./views/settings/subviews/chat-defaults/chat-defaults";
import { renderCharactersSettingsView } from "./views/settings/subviews/characters/characters";
import { renderSystemView } from "./views/settings/subviews/system/system";
import { renderPermissionsView } from "./views/settings/subviews/permissions/permissions";
import { renderStatuslineView } from "./views/settings/subviews/statusline/statusline";
import { renderAboutView } from "./views/settings/subviews/about/about";
import { renderRemoteAccessView } from "./views/settings/subviews/remote-access/remote-access";
import { renderAccountsSettingsView } from "./views/settings/subviews/accounts/accounts";
import { initBoot } from "./shared/boot";
import { ensureRemoteToken } from "./shared/remote-gate";
import { isRemote, getTransport } from "./shared/transport";
import { showView } from "./shared/navigation";
import { closeSidemenu } from "./shared/sidemenu";
import { initBackButton, registerOverlayBack } from "./shared/back-button";
import { installPermissionModalListener, setSidebarRerenderHook, setSelectedSessionId } from "./views/sessions/permission-modal";
import { renderSidebar } from "./views/sessions/sidebar";
import { installExternalLinkInterceptor } from "./shared/external-links";
import { invoke } from "./shared/ipc";
import { sessionEvents } from "./shared/chat/event-store";
import { openModelEffortModal } from "./views/sessions/model-effort-modal";
import { updateMissedPanel } from "./missed-panel";
import { setupRemoteVoicelines } from "./shared/remote-voiceline";
import "./missed-panel.css";
import type { ChatEvent, NewsPost, ScheduledItem } from "./types/ipc.generated";

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

// Test seam (ai_todo 53 e2e): in dev only, expose a helper that injects a
// synthetic file-edit tool_use into a mounted session so the wdio harness can
// exercise the inline edit-window + changes panel + activity bar WITHOUT a real
// (billed) claude turn. `import.meta.env.DEV` is true under the vite dev server
// the e2e harness loads; `vite build` strips this block from production bundles.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__injectEdit = (
    sessionId: string,
    opts: { tool: string; file: string; oldText?: string; newText?: string; content?: string }
  ): void => {
    const input =
      opts.tool === "Write"
        ? { file_path: opts.file, content: opts.content ?? opts.newText ?? "" }
        : { file_path: opts.file, old_string: opts.oldText ?? "", new_string: opts.newText ?? "" };
    const ev: ChatEvent = {
      type: "tool_use",
      tool_name: opts.tool,
      input,
      id: `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: BigInt(Date.now()),
      parent_tool_use_id: null,
    };
    sessionEvents.pushSynthetic(sessionId, ev);
  };

  // News e2e seam: inject synthetic posts into the news view so the wdio harness
  // can exercise the kebab menu + detail view + cached-summary render WITHOUT a
  // real (billed) claude summary call. The news view listens for this event.
  (window as unknown as Record<string, unknown>).__injectNews = (posts: unknown): void => {
    window.dispatchEvent(new CustomEvent("e2e-inject-news", { detail: posts }));
  };

  // AskUserQuestion e2e seam (ai_todo 16): exercise the question-card relay's
  // FRONTEND hop (Tauri `question-requested` event -> installed listener -> gate
  // -> showQuestionCard) WITHOUT a real claude turn or the daemon. `__injectQuestion`
  // emits the real Tauri event so the actual listener + gate fire; `__setSelectedSession`
  // primes the gate's selected id so a matching question is not parked.
  (window as unknown as Record<string, unknown>).__setSelectedSession = (id: string | null): void => {
    setSelectedSessionId(id);
  };
  (window as unknown as Record<string, unknown>).__injectQuestion = (payload: unknown): void => {
    void window.__TAURI__?.event?.emit?.("question-requested", payload);
  };

  // New-chat modal e2e seam (ai_todo 241): open the model/effort/account modal
  // directly so the view-harness can assert the account picker + "Start session"
  // gating WITHOUT driving the full pickProject flow. The account list comes from
  // the mocked list_accounts command, exactly as it would from the daemon on the
  // phone - so this exercises the frontend half of the mobile account-sharing fix.
  (window as unknown as Record<string, unknown>).__openNewChatModal = (
    projectPath?: string,
    projectName?: string,
  ): Promise<unknown> => openModelEffortModal(projectPath ?? "C:/test/proj", projectName ?? "Test Project");
}

registerView("dashboard", renderDashboard);
registerView("sessions", renderSessionsView);
registerView("history", renderHistoryView);
registerView("schedule", renderScheduleView);
registerView("projects", renderProjectsView);
registerView("characters", renderCharactersView);
registerView("character-detail", renderCharacterDetailView);
registerView("news", renderNewsView);
registerView("project-detail", renderProjectDetailView);
registerView("project-character-pick", renderCharacterPickView);
registerView("project-automation", renderAutomationView);
registerView("project-folder-mapping", renderFolderMappingView);
registerView("project-sessions", renderSessionsListView);
registerView("session-detail", renderSessionDetailView);
registerView("settings", renderSettingsView);
registerView("skill-detail", renderSkillDetailView);
registerView("skills", renderSkillsView);
registerView("settings-appearance", renderAppearanceView);
registerView("settings-notifications", renderNotificationsView);
registerView("settings-chat-defaults", renderChatDefaultsView);
registerView("settings-characters", renderCharactersSettingsView);
registerView("settings-system", renderSystemView);
registerView("settings-permissions", renderPermissionsView);
registerView("settings-statusline", renderStatuslineView);
registerView("settings-about", renderAboutView);
registerView("settings-remote-access", renderRemoteAccessView);
registerView("settings-accounts", renderAccountsSettingsView);

const app = document.getElementById("app");
if (!app) {
  throw new Error("Root element #app not found in index.html");
}

// Detached-window mode: backend opens a new Tauri window pointed at
// `index.html#detached?session=<id>`. Detect that URL shape BEFORE
// mounting the normal router (the router would treat "detached?..." as
// an unknown view name) and render the solo session pane instead.
function detachedSessionFromHash(): string | null {
  const hash = window.location.hash || "";
  if (!hash.startsWith("#detached")) return null;
  const qIdx = hash.indexOf("?");
  if (qIdx < 0) return null;
  const params = new URLSearchParams(hash.slice(qIdx + 1));
  return params.get("session");
}

// Signal to the Rust boot watchdog that the webview loaded successfully.
// If this never fires within ~6s, the watchdog reloads the window. Recovers
// from WebView2 "can't reach this page" caused by an unreachable start URL
// at boot (autostart racing the network / vite dev server).
void invoke("frontend_ready").catch(() => {});

installExternalLinkInterceptor();

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
// Let the permission relay re-render the sidebar when it parks/clears a
// backgrounded chat's prompt (injected to avoid a static import cycle).
setSidebarRerenderHook(() => {
  const listEl = document
    .querySelector<HTMLElement>(".view-sessions")
    ?.querySelector<HTMLElement>("#sessions-list");
  if (listEl) renderSidebar(listEl);
});
if (detachedSessionId) {
  document.body.classList.add("detached-mode");
  // Hide all static legacy views from index.html so only #app renders.
  document.querySelectorAll<HTMLElement>("body > .view").forEach((el) => el.classList.add("hidden"));
  void renderDetachedSession(app, detachedSessionId);
  // Skip mountRouter + sidemenu wiring; this window is single-purpose.
} else if (isScheduleWindow) {
  // Solo calendar render. Hide the static legacy views and mount the schedule
  // view straight into #app; no router, no boot (this window only shows the
  // calendar and cross-navigates to the Chats window on item click).
  document.querySelectorAll<HTMLElement>("body > .view").forEach((el) => el.classList.add("hidden"));
  void renderScheduleView(app);
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
      if (p) applyChatOpenRequest(p[0], p[1]);
    }).catch(() => {});
    void invoke<PendingNewChatPayload | null>("take_pending_new_chat").then((p) => {
      if (p) applyChatNewRequest(p);
    }).catch(() => {});
    const ev = window.__TAURI__?.event;
    if (ev?.listen) {
      void ev.listen<{ sessionId: string; mode: string }>(
        "chats-open-session",
        (e) => applyChatOpenRequest(e.payload?.sessionId, e.payload?.mode),
      );
      void ev.listen<PendingNewChatPayload>(
        "chats-new-chat",
        (e) => applyChatNewRequest(e.payload),
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
function applyChatOpenRequest(sessionId: string | undefined, mode: string | undefined): void {
  if (!sessionId) return;
  if (mode === "history") {
    queueHistorySelect(sessionId);
    showView("history");
  } else {
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
  remote?: boolean;
  characterId?: string | null;
}

function applyChatNewRequest(payload: PendingNewChatPayload | undefined): void {
  if (!payload?.projectPath) return;
  queueNewChat(
    { path: payload.projectPath, name: payload.projectName ?? payload.projectPath },
    {
      model: payload.model ?? "",
      effort: payload.effort ?? "",
      accountId: payload.accountId ?? null,
      autoAccept: payload.autoAccept,
      remote: payload.remote,
      characterId: payload.characterId ?? null,
    },
  );
  showView("sessions");
}

/** Build, show, and auto-dismiss one clickable toast in `#toastStack`. Shared
 * by the news-notification fallback and the scheduled-item-fired toast,
 * which previously each hand-rolled the same DOM-build/animate sequence
 * (create `.toast` > `.toast-msg`, wire onclick, append, rAF the `.show`
 * class, then `.leaving` + remove after the TTL). No-op if the stack host
 * isn't in the DOM. */
function pushToast(text: string, opts?: { onClick?: () => void; ttlMs?: number }): void {
  const stack = document.getElementById("toastStack");
  if (!stack) return;
  const ttlMs = opts?.ttlMs ?? 5000;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `<span class="toast-msg"></span>`;
  const msg = toast.querySelector(".toast-msg");
  if (msg) msg.textContent = text;
  if (opts?.onClick) toast.onclick = opts.onClick;
  stack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => toast.classList.add("leaving"), ttlMs);
  setTimeout(() => toast.remove(), ttlMs + 300);
}

function setupNewsBadgeAndNotifications(): void {
  const navItem = document.getElementById("sm-news");
  if (!navItem) return;

  const setBadge = (unread: number): void => {
    navItem.classList.toggle("has-unread", unread > 0);
  };

  // Initial unread snapshot. The 6h backend poll updates from there.
  void (async () => {
    try {
      const posts = await invoke<NewsPost[]>("list_news");
      setBadge((posts || []).filter((p) => p.unread).length);
    } catch (err) {
      console.warn("[news] initial list_news failed", err);
    }
  })();

  const ev = window.__TAURI__?.event;
  if (!ev?.listen) return;

  void ev.listen<{ unreadCount?: number }>("news-updated", (e) => {
    setBadge(e.payload?.unreadCount ?? 0);
  });

  void ev.listen<{ title?: string; body?: string }>("news-notification", async (e) => {
    const title = e.payload?.title || "Anthropic news";
    const body = e.payload?.body || "";
    try {
      if (typeof Notification !== "undefined") {
        if (Notification.permission === "default") {
          await Notification.requestPermission();
        }
        if (Notification.permission === "granted") {
          const n = new Notification(title, { body });
          n.onclick = () => { void showView("news"); window.focus(); };
          return;
        }
      }
    } catch (err) {
      console.warn("[news] OS notification failed", err);
    }
    // Fallback: lightweight in-app toast.
    pushToast(`${title}: ${body}`.trim(), { onClick: () => { void showView("news"); } });
  });
}

// Scheduled items (messages / new chats) that missed their fire time (past the
// grace window - see `daemon::schedule::compute_missed`). Global, not gated on
// the schedule view being open. Surfaced as a non-blocking, dismissible panel
// (see missed-panel.ts) with PERMANENT per-item dismissal, plus a one-shot OS
// notification per newly-missed item when the window is hidden (reusing the raw
// `Notification` API from the news path - no new plugin). `notifiedMissedIds`
// is in-memory (don't re-notify the same miss twice this session); the panel's
// own dismissal set is the durable localStorage one.
const notifiedMissedIds = new Set<string>();

function missedEntryName(i: ScheduledItem): string {
  if (i.kind.type === "new_chat") {
    const base = i.kind.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || i.kind.cwd;
    return `New chat: ${base}`;
  }
  const p = (i.prompt || "").trim().replace(/\s+/g, " ");
  return p.length > 60 ? `${p.slice(0, 60)}…` : p || "Scheduled message";
}

function missedEntryTime(i: ScheduledItem): string {
  const d = new Date(i.last_fired_at || i.fire_at);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function setupScheduleMissedPopup(): void {
  void getTransport().listen("scheduled-items-changed", async () => {
    let items: ScheduledItem[];
    try {
      items = (await invoke<ScheduledItem[]>("schedule_list")) || [];
    } catch (err) {
      console.warn("[schedule] schedule_list failed", err);
      return;
    }
    const missed = items
      .filter((i) => i.status.type === "missed")
      .sort((a, b) => new Date(b.last_fired_at || b.fire_at).getTime() - new Date(a.last_fired_at || a.fire_at).getTime());
    updateMissedPanel(
      missed.map((i) => ({ id: i.id, name: missedEntryName(i), time: missedEntryTime(i), kind: i.kind.type })),
      () => showView("schedule"),
    );

    // One OS notification per newly-missed item, only while the window's hidden.
    const fresh = missed.filter((i) => !notifiedMissedIds.has(i.id));
    for (const m of fresh) notifiedMissedIds.add(m.id);
    if (fresh.length > 0 && document.hidden) {
      const text = `${fresh.length} scheduled item${fresh.length === 1 ? "" : "s"} missed their fire time.`;
      try {
        if (typeof Notification !== "undefined") {
          if (Notification.permission === "default") await Notification.requestPermission();
          if (Notification.permission === "granted") {
            const n = new Notification("Claude Conductor", { body: text });
            n.onclick = () => { window.focus(); void showView("schedule"); };
          }
        }
      } catch (err) {
        console.warn("[schedule] OS notification failed", err);
      }
    }
  });
}

// A scheduled item just fired (daemon -> `scheduled-item-fired`). Pop a
// clickable toast so a scheduled chat/message doesn't spring to life silently
// (Joe's report: a scheduled new-chat "suddenly appeared" mid-response with no
// heads-up). Registered globally in both the main and Chats windows; clicking
// opens the chat via `open_chats_for_session` (which builds/focuses the Chats
// window and resumes a closed session). One event per fire, so no de-dup set.
interface ScheduledFirePayload { id: string; kind: string; session_id: string; prompt: string }

function setupScheduledFireToast(): void {
  void getTransport().listen<ScheduledFirePayload>("scheduled-item-fired", (p) => {
    if (!p?.session_id) return;
    const isNewChat = p.kind === "new_chat";
    const title = isNewChat ? "Scheduled chat started" : "Scheduled message sent";
    const detail = (p.prompt || "").trim().replace(/\s+/g, " ").slice(0, 60);

    pushToast(detail ? `${title}: ${detail}` : title, {
      ttlMs: 6000,
      onClick: () => {
        void invoke("open_chats_for_session", { sessionId: p.session_id, mode: "live" })
          .catch((err) => console.error("[schedule] open_chats_for_session failed", err));
      },
    });
  });
}

// Register the PWA service worker in browser-only mode (phone/remote client).
// Complete no-op in the Tauri webview: __TAURI__ is present there and SW
// registration would be irrelevant anyway (webview doesn't install PWAs).
if (typeof window !== "undefined" && !window.__TAURI__ && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js");
}
