// The Sessions view's cold-start sequence, split out of sessions.ts (todo
// 937): show the setup indicator, arm/disarm the daemon-connect stall timer,
// fetch the initial sessions/daemon-status/characters, then best-effort
// restore whatever the mount should land on. renderSessionsView composes
// this with the rest of the view's wiring; wireDaemonStatusListeners
// (sessions-wiring.ts) also calls arm/disarm as a reconnect fires.

import { invoke } from "../../shared/ipc";
import { isRemote } from "../../shared/transport";
import { state, loadLastSelectedSession } from "./state";
import { renderSidebar, refreshSessions } from "./sidebar";
import { refreshPaneEmptyState } from "./sessions-wiring";
import { loadSessionCharacters } from "./session-characters";
import { updateThinkingBar } from "./session-thinking-bar";
import { rateLimitBanner } from "../../shared/chat/rate-limit-banner";
import { selectSession } from "./active-session";
import { launchNewSession } from "./pending-flow";
import { consumePendingHistoryResume, consumePendingNewChat } from "./session-controls";

// If the daemon hasn't connected within this window, the sidebar's
// "Setting up..." spinner swaps to a visible warning (state.daemonSetupStalled)
// instead of spinning forever. The app's reconnect loop keeps retrying
// underneath; this is purely a surface so the user knows something is wrong.
const SETUP_STALL_MS = 15_000;
let _setupStallTimer: ReturnType<typeof setTimeout> | null = null;

export function armSetupStallTimer(listEl: HTMLElement, pane: HTMLElement, myMount: number): void {
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

export function disarmSetupStallTimer(): void {
  if (_setupStallTimer !== null) {
    clearTimeout(_setupStallTimer);
    _setupStallTimer = null;
  }
}

/** Shows the setup indicator, kicks off the initial sessions/daemon-status
 * fetch, and best-effort restores the queued-chat / history-resume /
 * last-selected session. Must not throw past its own try/catch: the event
 * listeners wired after this in renderSessionsView must still be registered
 * even if restore fails. */
export async function initialLoadAndRestore(pane: HTMLElement, listEl: HTMLElement, myMount: number): Promise<void> {
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

  // Queued-chat / restore-selection flow. MUST NOT abort the mount: the
  // registry/daemon-status listeners are registered after this returns, so an
  // exception here would leave the sidebar frozen on this first snapshot.
  // Restore is best-effort.
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
