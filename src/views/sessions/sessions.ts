import { render } from "lit-html";
import { template, detachedTemplate } from "./template";
import { invoke } from "../../shared/ipc";
import "../../shared/chat/chat.css";
import "./sessions.css";
import "./sessions-mobile.css";
import "./project-rail.css";
import "./changes-rail.css";
import "./session-list.css";
import "./session-row-portrait.css";
import "./rate-limit-banner.css";
import "./session-ctx-menu.css";
import "./session-avatar.css";
import "./session-statusbar.css";
import "./session-statusbar-images.css";
import "./project-picker.css";
import "./worktree-picker.css";
import "./model-effort-modal.css";
import "./new-project-modal.css";
import "./preview-panel.css";
import { startNewSession, launchNewSession, loadAndRestorePendingSession } from "./pending-flow";
import { selectSession, unwatchCurrentExternalSession, updateHeaderAvatarStatus } from "./active-session";
import { state, resetState, setActiveSession, loadLastSelectedSession } from "./state";
import { initThinkingBar, updateThinkingBar } from "./session-thinking-bar";
import { sessionSubtitle } from "./sessions-helpers";
import { renderSidebar, refreshSessions, closeCtxMenu } from "./sidebar";
import { loadSessionCharacters } from "./session-characters";
import { rateLimitBanner, isBlocked } from "../../shared/chat/rate-limit-banner";
import { getTransport, isRemote } from "../../shared/transport";
import { closeViewMoreMenu } from "./view-more-menu";
import { initMobileKeyboard } from "../../shared/mobile-keyboard";
import { backgroundRetainedChat, isRetainedRenderer } from "./chat-pane-cache";
import {
  getSelectedSessionId,
  reopenPendingPrompt,
} from "./permission-modal";
import { showToast } from "../../shared/toast";
import {
  setPaneRef,
  consumePendingOpenPicker,
  consumePendingHistoryResume,
  consumePendingNewChat,
} from "./session-controls";
import {
  wireRateLimitBanner,
  wireDaemonStatusListeners,
  wireInstancesChangedListener,
  wireChatRecoveryHeartbeat,
  reconcileEndedSessions,
  refreshPaneEmptyState,
} from "./sessions-wiring";
import {
  wirePreviewPanel,
  wireOverflowMenu,
  wireKeyboardShortcuts,
  wireStaticListeners,
  wireDocumentListeners,
} from "./sessions-dom-wiring";
export {
  queueHistoryResume,
  queueSessionSelect,
  queueNewChat,
  triggerNewSessionGlobal,
  selectSessionByIndex,
  selectSessionBySlot,
  assignCurrentToSlot,
  closeFocusedChat,
} from "./session-controls";

/** Session ids for which we have already called ensureSessionCharacter this
 * runtime. Prevents redundant IPC chatter on every instances-changed event.
 * Cleared on unmount so a fresh mount re-ensures any sessions that appeared
 * while the view was hidden. */
const _ensuredSessionIds = new Set<string>();

// ── Daemon setup stall detection ──────────────────────────────────────────────

// If the daemon hasn't connected within this window, the sidebar's
// "Setting up..." spinner swaps to a visible warning (state.daemonSetupStalled)
// instead of spinning forever. The app's reconnect loop keeps retrying
// underneath; this is purely a surface so the user knows something is wrong.
const SETUP_STALL_MS = 15_000;
let _setupStallTimer: ReturnType<typeof setTimeout> | null = null;

/** Poll-fallback timer for the lossy instances-changed broadcast (see the
 * setInterval at the listener registration site). Cleared in teardownState. */
let instancesPollTimer: ReturnType<typeof setInterval> | null = null;

/** Dispose function for the chat live-channel recovery heartbeat (see
 * wireChatRecoveryHeartbeat). Shared by both entry points below; cleared in
 * teardownState. */
let chatHeartbeatDispose: (() => void) | null = null;

function armSetupStallTimer(listEl: HTMLElement, pane: HTMLElement, myMount: number): void {
  if (_setupStallTimer !== null) clearTimeout(_setupStallTimer);
  _setupStallTimer = setTimeout(() => {
    _setupStallTimer = null;
    if (state.mountId !== myMount) return;
    if (state.daemonConnected === true) return;
    state.daemonSetupStalled = true;
    renderSidebar(listEl);
    refreshPaneEmptyState(pane);
  }, SETUP_STALL_MS);
}

function disarmSetupStallTimer(): void {
  if (_setupStallTimer !== null) {
    clearTimeout(_setupStallTimer);
    _setupStallTimer = null;
  }
}

// ── renderSessionsView setup helpers ──────────────────────────────────────────
// The wire* listener-setup functions live in sessions-wiring.ts (one job per
// file); renderSessionsView below is the ordered composition of those plus
// whatever genuinely can't be pulled out (initialLoadAndRestore, the stall
// timer, and the final teardown closure, which reach into several locals).

/** Shows the setup indicator, kicks off the initial sessions/daemon-status
 * fetch, and best-effort restores the queued-chat / history-resume /
 * last-selected session. Must not throw past its own try/catch: the click
 * and event listeners wired after this in renderSessionsView must still be
 * registered even if restore fails (see the "I can't click any of the
 * chats" failure mode noted inline below). */
async function initialLoadAndRestore(pane: HTMLElement, listEl: HTMLElement, myMount: number): Promise<void> {
  // Show setup indicator immediately (daemonConnected = null → centered
  // "Setting up..." in the pane; the sidebar stays blank until connected).
  renderSidebar(listEl);
  refreshPaneEmptyState(pane);
  armSetupStallTimer(listEl, pane, myMount);

  // Initial load - fetch sessions and daemon status in parallel. On remote,
  // is_daemon_connected has no HttpTransport mapping (always throws) - the
  // remote client IS the daemon connection, so getting here means it's up.
  const [, connected] = await Promise.all([
    refreshSessions(),
    isRemote() ? Promise.resolve(true) : invoke<boolean>("is_daemon_connected").catch(() => null),
    loadSessionCharacters(),
  ]);
  if (state.mountId === myMount) {
    state.daemonConnected = connected ?? null;
    if (connected === true) {
      state.daemonSetupStalled = false;
      disarmSetupStallTimer();
    }
    renderSidebar(listEl);
    refreshPaneEmptyState(pane);
    updateThinkingBar();
    rateLimitBanner.update(state.sessions);
  }

  // Queued-chat / restore-selection flow. MUST NOT abort the mount: the click
  // and event listeners below are registered after this block, so an exception
  // here would leave the sidebar rendered but permanently unclickable (the
  // "I can't click any of the chats" failure). Restore is best-effort.
  try {
    // If a new chat was queued (e.g. project-detail "+"), launch it now. Takes
    // precedence over history-resume / last-selected restore.
    const pendingNew = consumePendingNewChat();
    if (pendingNew) {
      const { project, config } = pendingNew;
      await launchNewSession(pane, project, config);
      updateThinkingBar();
    } else {
      const sid = consumePendingHistoryResume();
      if (sid && state.sessions.find(s => s.session_id === sid)) {
        await selectSession(sid, pane);
        updateThinkingBar();
      } else if (!state.pendingNewSession && !state.selectedId && !isRemote()) {
        // Restore the last-viewed session across reloads. Skipped when a pending
        // draft was just restored (it owns the active pane) or when history-resume
        // already picked one above. Desktop-only: on the remote/phone client a
        // refresh must land on the chat list, not jump back into the last-open
        // chat's detail pane (mobile is single-pane; this restore exists for
        // desktop's split-pane layout).
        const lastId = loadLastSelectedSession();
        if (lastId && state.sessions.find(s => s.session_id === lastId)) {
          await selectSession(lastId, pane);
          updateThinkingBar();
        }
      }
    }
  } catch (err) {
    console.error("[sessions] restore-selection failed; continuing mount", err);
  }
}

export async function renderSessionsView(root: HTMLElement): Promise<() => void> {
  // Reset state on each mount; bump mountId so any pending async work from
  // a prior mount sees a stale id and bails.
  const myMount = resetState();
  _ensuredSessionIds.clear();
  loadAndRestorePendingSession();

  render(template(), root);

  const view = root.querySelector<HTMLElement>(".view-sessions");
  const listEl = root.querySelector<HTMLElement>("#sessions-list");
  const pane = root.querySelector<HTMLElement>("#session-pane");
  const newBtn = root.querySelector<HTMLButtonElement>("#newSessionBtn");

  if (!view || !listEl || !pane) {
    console.error("[sessions] view template missing expected nodes");
    return () => { /* no-op */ };
  }

  setPaneRef(pane);
  let previewController = wirePreviewPanel(root, pane);
  initThinkingBar(pane);
  const teardownMobileKeyboard = initMobileKeyboard(view);

  // Click an unanswered AUQ card to put the real (answerable) card back up.
  // Gated on `.tool-qa-a--pending` so a resolved one doesn't reopen.
  // reopenPendingPrompt falls back to the daemon store when the in-memory park
  // died with its window; a dead click must say why - that was the bug.
  pane.addEventListener("click", (e) => {
    const card = (e.target as HTMLElement).closest(".msg.question-card");
    if (!card || !card.querySelector(".tool-qa-a--pending")) return;
    const sid = getSelectedSessionId();
    if (!sid) return;
    void (async () => {
      if (await reopenPendingPrompt(sid)) return;
      showToast("This question is no longer waiting for an answer.");
    })();
  });

  const teardownUsageDials = wireRateLimitBanner(root, listEl, myMount);

  if (consumePendingOpenPicker()) {
    void startNewSession(pane);
  }

  const teardownOverflowMenu = await wireOverflowMenu(root, previewController);
  const teardownKeyboardShortcuts = wireKeyboardShortcuts(listEl);

  await initialLoadAndRestore(pane, listEl, myMount);

  // Subscribe to live registry updates
  const ev = window.__TAURI__?.event;
  const teardownDaemonStatusListeners = await wireDaemonStatusListeners(
    ev, listEl, pane, myMount, armSetupStallTimer, disarmSetupStallTimer,
  );
  instancesPollTimer = await wireInstancesChangedListener(ev, listEl, pane, myMount, _ensuredSessionIds);
  chatHeartbeatDispose = wireChatRecoveryHeartbeat(myMount);

  wireStaticListeners(root, view, pane, listEl, newBtn);

  let unlistenDragEnter: (() => void) | null = null;
  let unlistenDragLeave: (() => void) | null = null;
  let unlistenFileDrop: (() => void) | null = null;
  void (async () => {
    if (!ev?.listen) return;
    [unlistenDragEnter, unlistenDragLeave, unlistenFileDrop] = await Promise.all([
      ev.listen("tauri://drag-enter", () => { view.classList.add("drag-over"); }),
      ev.listen("tauri://drag-leave", () => { view.classList.remove("drag-over"); }),
      ev.listen<{ paths: string[] }>("tauri://drag-drop", (e) => {
        view.classList.remove("drag-over");
        if (!state.composer || !e.payload.paths.length) return;
        void (async (composer, paths) => {
          for (const path of paths) await composer.attachFromPath(path);
        })(state.composer, e.payload.paths);
      }),
    ]);
  })();

  const teardownDocumentListeners = wireDocumentListeners(pane, listEl, myMount);

  return () => {
    teardownDocumentListeners();
    if (unlistenDragEnter) { try { unlistenDragEnter(); } catch { /* ignore */ } unlistenDragEnter = null; }
    if (unlistenDragLeave) { try { unlistenDragLeave(); } catch { /* ignore */ } unlistenDragLeave = null; }
    if (unlistenFileDrop) { try { unlistenFileDrop(); } catch { /* ignore */ } unlistenFileDrop = null; }
    view.classList.remove("drag-over");
    teardownKeyboardShortcuts();
    closeCtxMenu();
    closeViewMoreMenu();
    teardownOverflowMenu();
    teardownDaemonStatusListeners();
    teardownMobileKeyboard();
    previewController?.destroy();
    previewController = null;
    state.previewController = null;
    disarmSetupStallTimer();
    teardownUsageDials?.();
    teardownState();
  };
}

/**
 * Shared teardown: detach renderer/composer/statusbar, drop instance
 * listener, clear active session, drop the cached pane reference. Used by
 * both the main view and the detached-window entry.
 */
function teardownState(): void {
  unwatchCurrentExternalSession();
  setPaneRef(null);
  initThinkingBar(null);
  if (state.unlistenInstances) {
    try { state.unlistenInstances(); } catch { /* ignore */ }
    state.unlistenInstances = null;
  }
  if (state.unlistenScheduled) {
    try { state.unlistenScheduled(); } catch { /* ignore */ }
    state.unlistenScheduled = null;
  }
  if (instancesPollTimer !== null) {
    clearInterval(instancesPollTimer);
    instancesPollTimer = null;
  }
  if (chatHeartbeatDispose) {
    chatHeartbeatDispose();
    chatHeartbeatDispose = null;
  }
  // Leaving the Sessions view parks the open chat rather than tearing it down,
  // so coming back reopens it instantly. Non-retained renderers (pending pane)
  // still detach here.
  if (state.selectedId) backgroundRetainedChat(state.selectedId);
  if (state.renderer) {
    if (!isRetainedRenderer(state.renderer)) state.renderer.detach();
    state.renderer = null;
  }
  if (state.statusbar) {
    state.statusbar.destroy();
    state.statusbar = null;
  }
  state.composer?.destroy();
  state.composer = null;
  setActiveSession(null);
}

/**
 * Detached-window entry point. Renders ONLY the chat pane for `sessionId`
 * (no sidebar, no header). Called from main.ts when the URL hash starts
 * with `#detached?session=...`. Reuses the same selectSession internals
 * for renderer + composer wiring.
 *
 * Returns a teardown closure that detaches the renderer.
 */
export async function renderDetachedSession(
  root: HTMLElement,
  sessionId: string,
): Promise<() => void> {
  const myMount = resetState();

  // Solo chat layout: just the .session-pane, no sidebar, no header burger.
  render(detachedTemplate(sessionId), root);

  const pane = root.querySelector<HTMLElement>("#session-pane");
  if (!pane) {
    console.error("[sessions] detached template missing #session-pane");
    return () => { /* no-op */ };
  }
  // Main window's `renderSessionsView` does this too (see below) - without it
  // `updateThinkingBar()` no-ops forever (its `_pane` stays null), so the
  // pause button/held-messages "Send Now" bar never appears in this window
  // (Jarvis's only in-app surface - see jarvis-kebab-menu.ts's header note).
  initThinkingBar(pane);

  // We need state.sessions populated so selectSession can find the entry.
  await refreshSessions();
  if (state.mountId !== myMount) return () => { /* superseded */ };

  // Subscribe to instances-changed so the meta line refreshes if the
  // registry kind/busy/pid changes (e.g. takeover). Routed through the
  // transport seam so this also runs on the remote (phone) client.
  state.unlistenInstances = await getTransport().listen("instances-changed", async () => {
    if (state.mountId !== myMount) return;
    // Same ended/vanished diff as the main sessions view's handler (see
    // reconcileEndedSessions) - this detached window has its own event-store
    // singleton (separate webview), so it must reclaim its own cache entry
    // independently.
    const previousIds = new Set(state.sessions.map((s) => s.session_id));
    const refreshed = await refreshSessions();
    if (state.mountId !== myMount) return;
    reconcileEndedSessions(previousIds, refreshed);
    // Live-update the pane header title when the session name resolves, and
    // recolour the header avatar's status ring.
    if (state.selectedId) {
      const sess = state.sessions.find((s) => s.session_id === state.selectedId);
      if (sess) {
        const titleEl = pane.querySelector<HTMLElement>(".session-header .title");
        if (titleEl) {
          const newTitle = sessionSubtitle(sess);
          if (titleEl.textContent !== newTitle) titleEl.textContent = newTitle;
        }
        updateHeaderAvatarStatus(pane, sess);
        pane.classList.toggle("is-rate-limited", isBlocked(sess));
        state.composer?.refreshBlockedState();
      }
    }
    // Same busy-flag refresh the main window's instances-changed handler does
    // (sessions-wiring.ts) - without it, the pause button/Send-Now chip never
    // reacts once Jarvis starts or stops a turn after this initial mount.
    updateThinkingBar();
  });

  await selectSession(sessionId, pane);
  chatHeartbeatDispose = wireChatRecoveryHeartbeat(myMount);

  return teardownState;
}
