import { selectSession, updateHeaderAvatarStatus, carrySessionSettings } from "./active-session";
import { state, setActiveSession, loadLastSelectedSession } from "./state";
import { updateThinkingBar } from "./session-thinking-bar";
import { sessionSubtitle, paneEmptyStateHtml } from "./sessions-helpers";
import { renderSidebar, refreshSessions, forceRefreshScheduledCounts } from "./sidebar";
import { loadSessionCharacters } from "./session-characters";
import { api } from "../../shared/api";
import { rateLimitBanner, isBlocked } from "../../shared/chat/rate-limit-banner";
import { mountUsageDials } from "./usage-dials";
import { sessionEvents } from "../../shared/chat/event-store";
import { dropRetainedChat } from "./chat-pane-cache";
import { getTransport, isRemote } from "../../shared/transport";

/** Ambient Tauri event API surface, as declared on `Window.__TAURI__` in
 * shared/ipc.ts. Threaded through the wiring helpers below instead of each
 * one re-reading `window.__TAURI__?.event`. */
export type TauriEventApi = NonNullable<Window["__TAURI__"]>["event"];

/** Evicts the event-store cache for sessions that ended/vanished from
 *  `state.sessions`. `previousIds` must be snapshotted BEFORE the refresh
 *  that produced `refreshed`. Gated on `refreshed`: refreshSessions()'s catch
 *  empties state.sessions on ANY failure, indistinguishable from "all ended". */
export function reconcileEndedSessions(previousIds: Set<string>, refreshed: boolean): void {
  if (!refreshed) return;
  const currentIds = new Set(state.sessions.map((s) => s.session_id));
  for (const id of currentIds) sessionEvents.unmarkEnded(id);
  for (const id of previousIds) {
    if (!currentIds.has(id)) {
      sessionEvents.evictEnded(id);
      // A retained pane keeps a live subscriber, which would defer the store
      // teardown above forever. The open chat is spared: its pane is on screen.
      if (id !== state.selectedId) dropRetainedChat(id);
    }
  }
}

/**
 * Re-render the pane's empty state (the centered "Setting up..." /
 * "Select or create a session" block) to match the current daemon state.
 * No-op while a session or draft occupies the pane.
 */
export function refreshPaneEmptyState(pane: HTMLElement): void {
  if (!pane.querySelector(".session-empty")) return;
  pane.innerHTML = paneEmptyStateHtml(state.daemonConnected, state.daemonSetupStalled);
}

/** Mounts the global rate-limit banner plus the usage chip in the same
 * header row (also mounted independently in the detached chats window).
 * The daemon is the sole source of truth for blocked state; the banner is
 * purely a reflection of state.sessions. Returns the usage chip's teardown. */
export function wireRateLimitBanner(
  root: HTMLElement,
  pane: HTMLElement,
  listEl: HTMLElement,
  myMount: number,
): (() => void) | null {
  const rlHost = root.querySelector<HTMLElement>("#rate-limit-banner-host");
  if (rlHost) rateLimitBanner.mount(rlHost);

  const usageDialHost = root.querySelector<HTMLElement>("#usage-dial-host");
  const teardownUsageDials = usageDialHost && isRemote() ? mountUsageDials(usageDialHost) : null;
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
  // rate_limit is a live per-session event; the daemon's own instances_changed
  // broadcast (marks EVERY session) arrives separately and can lag (see
  // project_daemon_notifier_broadcast_lossy) - refresh proactively here so the
  // block shows instantly. The JSON itself is intercepted by event-store already.
  sessionEvents.setRateLimitHandler(() => {
    void (async () => {
      await refreshSessions();
      if (state.mountId !== myMount) return;
      renderSidebar(listEl);
      rateLimitBanner.update(state.sessions);
    })();
  });

  return teardownUsageDials;
}

/** Subscribes to settings-changed (re-resolve session hero assignments) and
 * daemon-status-changed (stall-timer arm/disarm + resync + restore-on-
 * reconnect); returns a dispose function. Stall-timer arm/disarm are
 * threaded in from sessions.ts rather than duplicated here. */
export async function wireDaemonStatusListeners(
  ev: TauriEventApi,
  listEl: HTMLElement,
  pane: HTMLElement,
  myMount: number,
  armSetupStallTimer: (listEl: HTMLElement, pane: HTMLElement, myMount: number) => void,
  disarmSetupStallTimer: () => void,
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

/** Defines syncInstances and subscribes it to instances-changed and
 * scheduled-items-changed, plus a low-frequency poll fallback for the lossy
 * daemon->app notifier. Returns the poll timer handle for teardownState to
 * clear. `ensuredSessionIds` is sessions.ts's set, threaded in not imported. */
export async function wireInstancesChangedListener(
  ev: TauriEventApi,
  listEl: HTMLElement,
  pane: HTMLElement,
  myMount: number,
  ensuredSessionIds: Set<string>,
): Promise<ReturnType<typeof setInterval> | null> {
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
    const newOnes = liveSessions.filter((s) => !ensuredSessionIds.has(s.session_id));
    if (newOnes.length > 0) {
      for (const s of newOnes) {
        ensuredSessionIds.add(s.session_id);
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
    // or it ended externally), clear the pane to avoid stale content. Skipped
    // while a new-session turn is pending: state.selectedId is the placeholder
    // id (not in the registry), and clearing here would kill the in-flight renderer.
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
    // after "Open in Terminal"), re-render to show the correct read-only UI.
    // Skipped for ids in takeoverInFlightIds - the takeover-btn handler owns
    // that transition in place and would otherwise race this reload.
    if (!state.pendingNewSession && state.selectedId && !state.takeoverInFlightIds.has(state.selectedId)) {
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
  // schedule/cancel action lands, instead of waiting for an unrelated
  // instances-changed event. Routed through the transport seam so this also
  // reaches the remote client (schedule_list itself stays desktop-only, ai_todo 257).
  state.unlistenScheduled = await getTransport().listen("scheduled-items-changed", () => {
    forceRefreshScheduledCounts();
  });
  // Poll fallback: the daemon->app notifier is lossy under pipe backpressure,
  // so a dropped instances_changed frame used to freeze a row's busy/awaiting
  // until an unrelated event happened to fire another broadcast. This heals
  // any dropped frame within 15s. Desktop-only: remote runs its own degrade-poll.
  if (ev?.listen) {
    let pollInFlight = false;
    return setInterval(() => {
      if (pollInFlight || state.mountId !== myMount) return;
      pollInFlight = true;
      void syncInstances().finally(() => { pollInFlight = false; });
    }, 15_000);
  }
  return null;
}

/** Cap on how many OTHER cached sessions the slow background sweep
 *  reconciles per tick - bounds worst-case `load_history_page` fan-out to a
 *  small, predictable number no matter how many chats Joe has backgrounded. */
const BACKGROUND_RECONCILE_CAP = 5;
const BACKGROUND_RECONCILE_EVERY_N_TICKS = 4;

/** Self-heals the visible chat's live channel, mirroring the 15s poll above -
 *  chat events have no such fallback and a dead listener never re-arms itself.
 *  Every tick force-reconciles `state.selectedId`; every 4th tick also sweeps
 *  the most-recently-active backgrounded sessions, which get zero
 *  reconciliation otherwise because the notifier is lossy. */
export function wireChatRecoveryHeartbeat(myMount: number): () => void {
  let tick = 0;
  const recover = (): void => {
    if (state.mountId !== myMount) return;
    const id = state.selectedId;
    if (id) {
      const sess = state.sessions.find((s) => s.session_id === id);
      const cwd = sess?.cwd ? String(sess.cwd) : undefined;
      void sessionEvents.reviveListener(id).catch((err) => console.warn(`[sessions] reviveListener(${id}) failed`, err));
      void sessionEvents.reconcileLatest(id, cwd, { force: true });
    }
    tick++;
    if (tick % BACKGROUND_RECONCILE_EVERY_N_TICKS !== 0) return;
    const others = sessionEvents.cachedSessionIdsByRecency()
      .filter((sid) => sid !== id)
      .slice(0, BACKGROUND_RECONCILE_CAP);
    for (const sid of others) {
      const sess = state.sessions.find((s) => s.session_id === sid);
      const cwd = sess?.cwd ? String(sess.cwd) : undefined;
      void sessionEvents.reconcileLatest(sid, cwd);
    }
  };
  const timer = setInterval(recover, 15_000);
  const onVisibilityChange = (): void => {
    if (document.visibilityState === "visible") recover();
  };
  window.addEventListener("focus", recover);
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    clearInterval(timer);
    window.removeEventListener("focus", recover);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
