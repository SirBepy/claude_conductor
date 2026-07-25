import { render } from "lit-html";
import { template, detachedTemplate } from "./template";
import { invoke } from "../../shared/ipc";
import * as shortcuts from "../../shared/shortcuts";
import "../../shared/chat/chat.css";
import "./sessions.css";
import "./project-rail.css";
import "./changes-rail.css";
import "./session-list.css";
import "./session-ctx-menu.css";
import "./session-avatar.css";
import "./session-statusbar.css";
import "./project-picker.css";
import "./worktree-picker.css";
import "./model-effort-modal.css";
import "./new-project-modal.css";
import "./preview-panel.css";
import { renderPreview, type PreviewController } from "./preview-panel";
import { startNewSession, launchNewSession, discardDraft, resumeDraft, loadAndRestorePendingSession } from "./pending-flow";
import { discardComposerDraft, moveComposerDraft } from "../../shared/chat/composer";
import { selectSession, unwatchCurrentExternalSession, updateHeaderAvatarStatus, carrySessionSettings } from "./active-session";
import { state, resetState, setActiveSession, loadLastSelectedSession, clearLastSelectedSession } from "./state";
import { initThinkingBar, updateThinkingBar } from "./session-thinking-bar";
import { sessionSubtitle, paneEmptyStateHtml } from "./sessions-helpers";
import { renderSidebar, refreshSessions, openCtxMenu, closeCtxMenu, openDraftCtxMenu, forceRefreshScheduledCounts } from "./sidebar";
import { loadSessionCharacters } from "./session-characters";
import { api } from "../../shared/api";
import { rateLimitBanner, isBlocked } from "../../shared/chat/rate-limit-banner";
import { mountUsageChip } from "./usage-chip";
import { sessionEvents } from "../../shared/chat/event-store";
import { getTransport, isRemote } from "../../shared/transport";
import {
  initWhenDone,
  subscribeWhenDone,
} from "./when-done";
import {
  closeViewMoreMenu,
  refreshViewMoreIndicator,
  rerenderViewMenuProtocol,
  toggleViewMoreMenu,
} from "./view-more-menu";
import {
  dismissQuestionCard,
  getSelectedSessionId,
  replayPendingPrompt,
} from "./permission-modal";
import {
  setPaneRef,
  consumePendingOpenPicker,
  consumePendingHistoryResume,
  consumePendingNewChat,
  selectSessionByIndex,
  selectSessionBySlot,
  assignCurrentToSlot,
  closeFocusedChat,
} from "./session-controls";
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

/**
 * Reclaim the event-store cache entry (listeners + buffered events) of any
 * session that just ended or vanished from `state.sessions` (refreshSessions()
 * replaces it with only the LIVE ones - sidebar.ts's isLive filters out
 * ended_at). `previousIds` must be snapshotted BEFORE the refresh that
 * produced `refreshed`; ids still present un-latch a stale `ended` mark left
 * by an earlier transient vanish (e.g. daemon restart) so closing the pane
 * later doesn't tear down a live session's cache. Eviction is deferred by
 * evictEnded itself if the session is still open in this pane.
 *
 * Gated on `refreshed`: refreshSessions()'s catch empties state.sessions on
 * ANY list_instances failure, which this diff cannot tell apart from
 * "everything ended" - evicting there would flush every background cache on
 * a transient IPC blip. A successful-but-empty list still evicts (those
 * sessions genuinely ended). Shared by the main sessions view's and the
 * detached window's instances-changed handlers, each with their own
 * event-store singleton (separate webviews).
 */
function reconcileEndedSessions(previousIds: Set<string>, refreshed: boolean): void {
  if (!refreshed) return;
  const currentIds = new Set(state.sessions.map((s) => s.session_id));
  for (const id of currentIds) sessionEvents.unmarkEnded(id);
  for (const id of previousIds) {
    if (!currentIds.has(id)) sessionEvents.evictEnded(id);
  }
}

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

/**
 * Re-render the pane's empty state (the centered "Setting up..." /
 * "Select or create a session" block) to match the current daemon state.
 * No-op while a session or draft occupies the pane.
 */
function refreshPaneEmptyState(pane: HTMLElement): void {
  if (!pane.querySelector(".session-empty")) return;
  pane.innerHTML = paneEmptyStateHtml(state.daemonConnected, state.daemonSetupStalled);
}

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

function discardStuckPending(pane: HTMLElement): void {
  const pending = state.pendingNewSession;
  if (!pending) return;
  // No confirm() guard: native confirm routes through the dialog plugin, which
  // is blocked by the ACL in this window. The X is already explicit intent.
  void (async () => {
    const target = pending.realId ?? pending.placeholderId;
    try { await invoke<void>("cancel_turn", { sessionId: target }); } catch { /* best-effort */ }
    if (pending.realId) {
      try { await invoke<void>("clear_session", { sessionId: pending.realId }); } catch { /* best-effort */ }
    }
    discardDraft(pane);
    updateThinkingBar();
  })();
}

/** Ambient Tauri event API surface, as declared on `Window.__TAURI__` in
 * shared/ipc.ts. Threaded through the wiring helpers below instead of each
 * one re-reading `window.__TAURI__?.event`. */
type TauriEventApi = NonNullable<Window["__TAURI__"]>["event"];

// ── renderSessionsView setup helpers ──────────────────────────────────────────
// Each helper below owns one self-contained slice of renderSessionsView's
// mount sequence (extracted verbatim, ai_todo 300); renderSessionsView is
// just the ordered composition of these plus whatever genuinely can't be
// pulled out (the final teardown closure, which reaches into several of
// their locals).

/** Docked HTML preview panel (ai_todo 138): a snapshot store rendered as a
 * right-rail sibling of the pane, scoped to whichever chat is active (see
 * state.ts's setActiveSession -> previewController.setSessionScope). */
function wirePreviewPanel(root: HTMLElement, pane: HTMLElement): PreviewController | null {
  const previewRoot = root.querySelector<HTMLElement>("#preview-panel-host");
  const previewController: PreviewController | null =
    previewRoot ? renderPreview(previewRoot, { mode: "panel" }) : null;
  state.previewController = previewController;
  previewController?.setSessionScope(state.selectedId);
  state.launchNewChatCallback = (project, config) => { void launchNewSession(pane, project, config); };
  return previewController;
}

/** Mounts the global rate-limit banner (top of the Chats window; also
 * mounted independently in the detached session-chats window, same module)
 * plus the usage chip that lives in the same header row. The daemon is the
 * sole source of truth for blocked state now - it marks
 * Instance.rate_limited_resets_at, schedules the resume itself, and
 * publishes instances_changed. The banner is purely a reflection of that,
 * re-rendered from state.sessions on every refresh below. Returns the usage
 * chip's teardown (or null if it was never mounted). */
function wireRateLimitBanner(
  root: HTMLElement,
  pane: HTMLElement,
  listEl: HTMLElement,
  myMount: number,
): (() => void) | null {
  const rlHost = root.querySelector<HTMLElement>("#rate-limit-banner-host");
  if (rlHost) rateLimitBanner.mount(rlHost);

  const usageChipHost = root.querySelector<HTMLElement>("#usage-chip-host");
  const teardownUsageChip = usageChipHost && isRemote() ? mountUsageChip(usageChipHost) : null;
  rateLimitBanner.setSelectedSessionGetter(() => state.selectedId);
  rateLimitBanner.setOnMoved((newId, oldId) => {
    carrySessionSettings(oldId, newId);
    void (async () => {
      await refreshSessions();
      if (state.mountId !== myMount) return;
      renderSidebar(listEl);
      rateLimitBanner.update(state.sessions);
      await selectSession(newId, pane);
    })();
  });
  // The rate_limit notification is a live stream event for the one session
  // that got rejected; the daemon's own instances_changed broadcast (which
  // marks EVERY session on the account) arrives separately and can lag (see
  // project_daemon_notifier_broadcast_lossy) - proactively refresh here so
  // the block shows instantly instead of waiting for that broadcast. The
  // rate_limit JSON itself is intercepted by event-store's deliver() before
  // it can reach the transcript; this handler never needs its body.
  sessionEvents.setRateLimitHandler(() => {
    void (async () => {
      await refreshSessions();
      if (state.mountId !== myMount) return;
      renderSidebar(listEl);
      rateLimitBanner.update(state.sessions);
    })();
  });

  return teardownUsageChip;
}

/** Wires the "more options" overflow button, the preview-panel toggle button
 * inside it, and the sleep/shutdown-when-done protocol subscription that
 * keeps the overflow menu's indicator dot + protocol section live. Returns a
 * dispose function for the whenDone subscription/listener. */
async function wireOverflowMenu(
  root: HTMLElement,
  previewController: PreviewController | null,
): Promise<() => void> {
  const viewMoreBtn = root.querySelector<HTMLButtonElement>("#viewMoreBtn");
  if (viewMoreBtn) {
    viewMoreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleViewMoreMenu(viewMoreBtn);
    });
  }

  const previewToggleBtn = root.querySelector<HTMLButtonElement>("#previewToggleBtn");
  if (previewToggleBtn) {
    previewToggleBtn.addEventListener("click", () => {
      closeViewMoreMenu();
      previewController?.toggle();
    });
  }

  // Hydrate + subscribe to the global sleep/shutdown-when-done protocol state.
  // The subscriber refreshes the more-button indicator dot and, if the menu is
  // open, live-updates its protocol section (toggles + countdown chip).
  const unlistenWhenDone = await initWhenDone();
  const unsubWhenDone = subscribeWhenDone(() => {
    refreshViewMoreIndicator();
    rerenderViewMenuProtocol();
  });
  refreshViewMoreIndicator();

  return () => {
    unsubWhenDone();
    unlistenWhenDone();
  };
}

/** Registers the chats-view keyboard shortcuts (numbered slot jump/assign,
 * close-chat) and the ctrl-held sidebar hint class. Returns a dispose
 * function that unregisters everything. */
function wireKeyboardShortcuts(listEl: HTMLElement): () => void {
  for (let i = 0; i < 9; i++) {
    const slot = i + 1;
    shortcuts.register(`open-chat-${slot}`, () => {
      if (shortcuts.getChatSlotMode() === "manual") {
        selectSessionBySlot(slot);
      } else {
        selectSessionByIndex(i);
      }
    });
    shortcuts.register(`assign-slot-${slot}`, () => assignCurrentToSlot(slot));
  }
  shortcuts.register("close-chat", closeFocusedChat);

  const unlistenCtrlHeld = shortcuts.onCtrlHeld((held) => {
    listEl.classList.toggle("kbd-hint-active", held);
  });

  return () => {
    for (let i = 1; i <= 9; i++) {
      shortcuts.unregister(`open-chat-${i}`);
      shortcuts.unregister(`assign-slot-${i}`);
    }
    shortcuts.unregister("close-chat");
    unlistenCtrlHeld();
  };
}

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

  // Initial load - fetch sessions and daemon status in parallel
  const [, connected] = await Promise.all([
    refreshSessions(),
    invoke<boolean>("is_daemon_connected").catch(() => null),
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

/** Subscribes to settings-changed (re-resolve session hero assignments) and
 * daemon-status-changed (stall-timer arm/disarm + resync + restore-on-
 * reconnect). No-op if the Tauri event bridge isn't present. Returns a
 * dispose function. */
async function wireDaemonStatusListeners(
  ev: TauriEventApi,
  listEl: HTMLElement,
  pane: HTMLElement,
  myMount: number,
): Promise<() => void> {
  let unlistenDaemonStatus: (() => void) | null = null;
  let unlistenSettingsChanged: (() => void) | null = null;
  if (ev?.listen) {
    // Re-resolve session hero assignments whenever a character changes
    // (ensure on appearance, manual pick, or re-roll), then repaint the sidebar.
    unlistenSettingsChanged = await ev.listen("settings-changed", async () => {
      if (state.mountId !== myMount) return;
      await loadSessionCharacters();
      if (state.mountId !== myMount) return;
      renderSidebar(listEl);
    });

    unlistenDaemonStatus = await ev.listen<{ connected: boolean }>("daemon-status-changed", (e) => {
      if (state.mountId !== myMount) return;
      state.daemonConnected = e.payload.connected;
      if (e.payload.connected) {
        state.daemonSetupStalled = false;
        disarmSetupStallTimer();
        // Re-sync on reconnect: the seed `instances-changed` from fetch_and_reseed_instances
        // fires before the JS listener at line 336 is registered and is silently lost.
        // Calling refreshSessions() here (after daemon-status-changed, which fires after
        // instances-changed in the Rust sequence) guarantees we get the live busy flags.
        void (async () => {
          await refreshSessions();
          if (state.mountId !== myMount) return;
          renderSidebar(listEl);
          updateThinkingBar();
          rateLimitBanner.update(state.sessions);
          // If the initial mount's session restore failed (cached_instances was empty
          // at that point), try again now that the daemon is connected. Desktop-only
          // (see the initial-mount restore above for why mobile skips this).
          if (!state.selectedId && !state.pendingNewSession && !isRemote()) {
            const lastId = loadLastSelectedSession();
            if (lastId && state.sessions.find(s => s.session_id === lastId)) {
              await selectSession(lastId, pane);
              if (state.mountId !== myMount) return;
              updateThinkingBar();
            }
          }
        })();
      } else {
        armSetupStallTimer(listEl, pane, myMount);
      }
      renderSidebar(listEl);
      refreshPaneEmptyState(pane);
    });
  }

  return () => {
    if (unlistenDaemonStatus) { try { unlistenDaemonStatus(); } catch { /* ignore */ } }
    if (unlistenSettingsChanged) { try { unlistenSettingsChanged(); } catch { /* ignore */ } }
  };
}

/** Defines syncInstances (the shared instances-changed/poll-fallback
 * handler) and subscribes it to both the instances-changed and
 * scheduled-items-changed transport events, plus the low-frequency poll
 * fallback for the lossy daemon->app notifier. No dispose needed: the
 * unlisten handles are stashed on `state`/module-level `instancesPollTimer`,
 * which teardownState() already reclaims. */
async function wireInstancesChangedListener(
  ev: TauriEventApi,
  listEl: HTMLElement,
  pane: HTMLElement,
  myMount: number,
): Promise<void> {
  const syncInstances = async (): Promise<void> => {
    if (state.mountId !== myMount) return;
    // See reconcileEndedSessions for why previousIds is snapshotted before
    // the refresh and why eviction is gated on `refreshed`.
    const previousIds = new Set(state.sessions.map((s) => s.session_id));
    const refreshed = await refreshSessions();
    if (state.mountId !== myMount) return;
    reconcileEndedSessions(previousIds, refreshed);

    // Ensure every newly-appeared live session gets a character assigned.
    // Track ensured ids so we don't re-call on every subsequent event.
    const liveSessions = state.sessions.filter((s) => !s.ended_at && !s.end_reason);
    const newOnes = liveSessions.filter((s) => !_ensuredSessionIds.has(s.session_id));
    if (newOnes.length > 0) {
      for (const s of newOnes) {
        _ensuredSessionIds.add(s.session_id);
      }
      await Promise.all(newOnes.map((s) => api.ensureSessionCharacter(s.session_id).catch(() => null)));
      if (state.mountId !== myMount) return;
      await loadSessionCharacters();
      if (state.mountId !== myMount) return;
    }

    renderSidebar(listEl);
    updateThinkingBar();
    rateLimitBanner.update(state.sessions);
    // If the initial mount's session restore failed (daemon not yet connected),
    // restore now on the first instances-changed that populates the list.
    // Desktop-only (see the initial-mount restore above for why mobile skips this).
    if (!state.selectedId && !state.pendingNewSession && !isRemote()) {
      const lastId = loadLastSelectedSession();
      if (lastId && state.sessions.find(s => s.session_id === lastId)) {
        await selectSession(lastId, pane);
        if (state.mountId !== myMount) return;
        updateThinkingBar();
      }
    }
    // Live-update the pane header title when the session name resolves, and
    // recolour the header avatar's status ring (busy -> done, etc.).
    if (state.selectedId && !state.pendingNewSession) {
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
    // If the previously-selected session vanished (e.g. takeover renamed it,
    // or it was ended externally), clear the pane to avoid stale content.
    // Skip this check while a new-session turn is pending: state.selectedId
    // is the placeholder id (not in the registry), and clearing the pane
    // would tear down the in-flight renderer mid-stream.
    if (
      !state.pendingNewSession &&
      state.selectedId &&
      !state.sessions.find((s) => s.session_id === state.selectedId)
    ) {
      if (state.renderer) state.renderer.detach();
      state.renderer = null;
      state.composer?.destroy();
      state.composer = null;
      setActiveSession(null);
      pane.innerHTML = paneEmptyStateHtml(state.daemonConnected, state.daemonSetupStalled);
    }
    // If the selected session's kind changed (e.g. Interactive -> External
    // after "Open in Terminal"), the pane must re-render to show the correct
    // read-only UI. Detect by comparing pane DOM vs current kind.
    if (!state.pendingNewSession && state.selectedId) {
      const updatedSess = state.sessions.find((s) => s.session_id === state.selectedId);
      if (updatedSess) {
        const paneIsReadOnly = !!pane.querySelector(".readonly-banner");
        const sessIsReadOnly = updatedSess.kind === "external";
        if (paneIsReadOnly !== sessIsReadOnly) {
          const reloadId = state.selectedId;
          setActiveSession(null);
          await selectSession(reloadId, pane);
        }
      }
    }
  };
  // Routed through the transport seam (not the direct window.__TAURI__?.event
  // check above) so this also runs on the remote (phone) client: HttpTransport
  // fans "instances-changed" out from the daemon's global WS stream, while
  // TauriTransport wraps the same desktop Tauri event used before.
  state.unlistenInstances = await getTransport().listen("instances-changed", () => { void syncInstances(); });
  // Recount the sidebar's scheduled-message marker/badge the moment a
  // schedule/cancel action lands, instead of waiting for the next unrelated
  // instances-changed event (which may not fire at all while the chat sits
  // idle). Routed through the same transport seam so it also works on the
  // remote (phone) client - schedule_list itself is still desktop/local-only
  // data (ai_todo 257), but the event now reaches both transports.
  state.unlistenScheduled = await getTransport().listen("scheduled-items-changed", () => {
    forceRefreshScheduledCounts();
  });
  // Poll fallback: the daemon->app notifier is lossy under pipe backpressure
  // (the permission-prompt path has its own poll for the same reason). A
  // dropped instances_changed frame used to freeze a row's busy/awaiting at
  // its last-known value until some unrelated session event happened to
  // fire another broadcast. This low-frequency full resync heals any
  // dropped frame within 15s. Skipped while a previous poll-triggered sync
  // is still in flight. Desktop-only: the remote transport already runs its
  // own degrade-poll internally while its global WS is down/stale.
  if (ev?.listen) {
    let pollInFlight = false;
    instancesPollTimer = setInterval(() => {
      if (pollInFlight || state.mountId !== myMount) return;
      pollInFlight = true;
      void syncInstances().finally(() => { pollInFlight = false; });
    }, 15_000);
  }
}

/** Wires the +New button, its floating FAB twin, the mobile back button,
 * the sidebar's right-click context menu, and the sidebar's main click
 * handler (row menu buttons, parked/pending/draft rows, session rows). None
 * of these are torn down explicitly on unmount in the original code either -
 * the listEl/pane/newBtn nodes are discarded wholesale by the next mount's
 * `render(template(), root)` call, so no dispose function is needed here. */
function wireStaticListeners(
  root: HTMLElement,
  view: HTMLElement,
  pane: HTMLElement,
  listEl: HTMLElement,
  newBtn: HTMLButtonElement | null,
): void {
  // Wire +New
  if (newBtn) {
    newBtn.disabled = false;
    newBtn.title = "New session";
    newBtn.addEventListener("click", () => void startNewSession(pane));
  }

  // Wire the floating "new chat" CTA on the chats list (same action as +New).
  const fab = root.querySelector<HTMLButtonElement>("#sessionsFab");
  fab?.addEventListener("click", () => void startNewSession(pane));

  // Mobile back button: return from the chat pane to the session list overlay.
  // Only visible on ≤768px in chat mode (CSS-driven); a no-op on desktop.
  const backBtn = root.querySelector<HTMLButtonElement>("#sessionsBackBtn");
  backBtn?.addEventListener("click", () => view.setAttribute("data-mobile-pane", "list"));

  // Sort select moved to Settings. No binding needed here; sessions.ts reads
  // the persisted localStorage value on each renderSidebar call via loadSort().

  // Right-click anywhere on a session row opens the same context menu the
  // hover-revealed ⋮ button does (the button stays for discoverability).
  listEl.addEventListener("contextmenu", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLLIElement>("li[data-session-id]");
    const sid = li?.dataset.sessionId;
    if (!li || !sid) return;
    e.preventDefault();
    openCtxMenu(sid, li);
  });

  listEl.addEventListener("click", (e) => {
    // All row menu buttons (3-dot) — handles live sessions, active drafts, and parked drafts.
    const menuBtn = (e.target as HTMLElement).closest<HTMLButtonElement>(".session-row-menu-btn");
    if (menuBtn) {
      e.stopPropagation();
      const sid = menuBtn.dataset.sessionId;
      const parkedPid = menuBtn.dataset.parkedPlaceholderId;
      if (sid) {
        openCtxMenu(sid, menuBtn);
      } else if (parkedPid) {
        openDraftCtxMenu(menuBtn, () => {
          state.parkedDrafts = state.parkedDrafts.filter(d => d.placeholderId !== parkedPid);
          discardComposerDraft(parkedPid);
          renderSidebar(listEl);
        });
      } else if (menuBtn.dataset.draftMenu === "1") {
        openDraftCtxMenu(menuBtn, () => {
          if (state.pendingNewSession?.firstMessageSent) discardStuckPending(pane);
          else { discardDraft(pane); updateThinkingBar(); }
        });
      }
      return;
    }

    // Click on a parked draft row body: resume it as a new draft.
    const parkedLi = (e.target as HTMLElement).closest<HTMLLIElement>("li.parked-draft[data-placeholder-id]");
    if (parkedLi) {
      const pid = parkedLi.dataset.placeholderId;
      if (pid) {
        const draft = state.parkedDrafts.find(d => d.placeholderId === pid);
        if (draft) {
          const oldPid = draft.placeholderId;
          state.parkedDrafts = state.parkedDrafts.filter(d => d.placeholderId !== pid);
          void (async () => {
            await launchNewSession(pane, { path: draft.projectPath, name: draft.projectName }, draft.config);
            const newPid = state.pendingNewSession?.placeholderId;
            if (newPid && newPid !== oldPid) {
              moveComposerDraft(oldPid, newPid);
              state.composer?.setSessionId(newPid, { readOnly: false });
            }
            updateThinkingBar();
          })();
        }
      }
      return;
    }

    // Draft row click: re-open the pending pane.
    const draftLi = (e.target as HTMLElement).closest<HTMLLIElement>("li.pending.draft");
    if (draftLi) {
      void (async () => { await resumeDraft(pane); updateThinkingBar(); })();
      return;
    }

    // Starting pending row click. Two cases:
    //   - realId already known (SessionStarted fired): navigate to the real
    //     session so the user can see what's going on. The pending row stays
    //     visible until start_session resolves; click on the X button (handled
    //     above via [data-discard-stuck]) is still the only way to abort.
    //   - realId not yet known: leave the click as a no-op. The X button on
    //     the row handles discard; clicking the row body shouldn't trigger a
    //     destructive confirm dialog.
    const startingLi = (e.target as HTMLElement).closest<HTMLLIElement>("li.pending:not(.draft)");
    if (startingLi && startingLi.dataset.pending === "1") {
      const pending = state.pendingNewSession;
      const realId = pending?.realId;
      if (realId) {
        void (async () => { await selectSession(realId, pane); updateThinkingBar(); })();
      }
      return;
    }

    const li = (e.target as HTMLElement).closest<HTMLLIElement>("li[data-session-id]");
    if (!li) return;
    const id = li.dataset.sessionId;
    if (id) {
      void (async () => { await selectSession(id, pane); updateThinkingBar(); })()
        .catch((err) => console.error(`[sessions] selectSession(${id}) failed`, err));
    }
  });
}

/** Subscribes the three document-level custom events the rest of the app
 * dispatches at this pane (session-closed from elsewhere, sort-preference
 * change from Settings, "delete draft" from the view-more menu). Returns a
 * dispose function that removes all three. */
function wireDocumentListeners(pane: HTMLElement, listEl: HTMLElement, myMount: number): () => void {
  const onSessionClosed = (e: Event) => {
    const { sessionId } = (e as CustomEvent<{ sessionId: string }>).detail;
    if (state.selectedId !== sessionId) return;
    if (state.renderer) state.renderer.detach();
    state.renderer = null;
    state.composer?.destroy();
    state.composer = null;
    setActiveSession(null);
    // Explicit close: forget the persisted chat so a restart doesn't re-open it.
    clearLastSelectedSession();
    pane.innerHTML = paneEmptyStateHtml(state.daemonConnected, state.daemonSetupStalled);
    // Optimistic removal: drop the row immediately without waiting for
    // instances-changed from the daemon (which takes a few seconds).
    state.sessions = state.sessions.filter(s => s.session_id !== sessionId);
    renderSidebar(listEl);
  };
  document.addEventListener("cc:session-closed", onSessionClosed);

  // When the Settings view changes the sort preference, rerender the sidebar.
  const onSortChanged = () => {
    if (state.mountId !== myMount) return;
    renderSidebar(listEl);
  };
  document.addEventListener("cc-sort-changed", onSortChanged);

  // view-more-menu dispatches this when the draft "Delete draft" is tapped.
  const onDiscardPendingDraft = () => {
    if (state.mountId !== myMount) return;
    if (state.pendingNewSession?.firstMessageSent) discardStuckPending(pane);
    else { discardDraft(pane); updateThinkingBar(); }
  };
  document.addEventListener("discard-pending-draft", onDiscardPendingDraft);

  return () => {
    document.removeEventListener("cc:session-closed", onSessionClosed);
    document.removeEventListener("cc-sort-changed", onSortChanged);
    document.removeEventListener("discard-pending-draft", onDiscardPendingDraft);
  };
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

  // Clicking a pending "awaiting answer" chip in the chat dismisses any active
  // AUQ card and re-surfaces it. Handles the case where the modal somehow got
  // closed without answering (navigated away and back, dismissed by mistake).
  pane.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".tool-qa-a--pending")) return;
    const sid = getSelectedSessionId();
    if (!sid) return;
    dismissQuestionCard();
    replayPendingPrompt(sid);
  });

  const teardownUsageChip = wireRateLimitBanner(root, pane, listEl, myMount);

  if (consumePendingOpenPicker()) {
    void startNewSession(pane);
  }

  const teardownOverflowMenu = await wireOverflowMenu(root, previewController);
  const teardownKeyboardShortcuts = wireKeyboardShortcuts(listEl);

  await initialLoadAndRestore(pane, listEl, myMount);

  // Subscribe to live registry updates
  const ev = window.__TAURI__?.event;
  const teardownDaemonStatusListeners = await wireDaemonStatusListeners(ev, listEl, pane, myMount);
  await wireInstancesChangedListener(ev, listEl, pane, myMount);

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
    previewController?.destroy();
    previewController = null;
    state.previewController = null;
    disarmSetupStallTimer();
    teardownUsageChip?.();
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
  if (state.renderer) {
    state.renderer.detach();
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
  });

  await selectSession(sessionId, pane);

  return teardownState;
}
