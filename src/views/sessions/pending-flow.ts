import { discardComposerDraft } from "../../shared/chat/composer";
import { invoke } from "../../shared/ipc";
import { showToast } from "../../shared/toast";
import { state, setActiveSession, type ParkedDraft } from "./state";
import { pickProject } from "./project-picker";
import { renderSidebar } from "./sidebar";
import { openModelEffortModal, type SessionConfig } from "./model-effort-modal";
import { savePendingSession, loadPendingSession, clearPendingSession } from "./pending-draft-storage";
import { renderPendingPane } from "./pending-pane";
import { paneEmptyStateHtml, ownedScheduledNewChatIds } from "./sessions-helpers";
import type { ScheduledItem } from "../../types/ipc.generated";

/**
 * Generate a placeholder session id used to subscribe `chat:<id>` BEFORE
 * the real session_id is known. The Rust side validates this matches
 * `pending-` + alphanumeric/dash/underscore. We append a millisecond
 * timestamp + 8 random hex chars to keep two concurrent new-session
 * attempts isolated.
 */
export function makePlaceholderId(): string {
  const ts = Date.now();
  const rnd = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
  return `pending-${ts}-${rnd}`;
}


/**
 * Fire-and-forget, so it never blocks the discard UI. Known gap: a parked draft
 * resumed under a new placeholderId leaves the old schedule stale.
 */
async function cancelOwnedSchedule(placeholderId: string): Promise<void> {
  try {
    const items = await invoke<ScheduledItem[]>("schedule_list");
    const owned = ownedScheduledNewChatIds(items, placeholderId);
    if (owned.length === 0) return;
    await Promise.all(owned.map((id) => invoke<void>("schedule_delete", { id })));
    showToast(
      owned.length === 1
        ? "Also canceled the chat that was scheduled from this draft."
        : `Also canceled ${owned.length} chats that were scheduled from this draft.`,
    );
  } catch (err) {
    console.error("[sessions] failed to cancel scheduled item for discarded draft", err);
  }
}

export function loadAndRestorePendingSession(): void {
  const pending = loadPendingSession();
  if (!pending) return;
  // If the first message was already sent, the IPC promise that would have
  // resolved the session_id and called clearPendingSession is dead (page
  // reloaded). Clear it so the real session surfaces from the registry
  // instead of being hidden by the sidebar's cwd-suppression filter.
  if (pending.firstMessageSent) {
    clearPendingSession();
    return;
  }
  state.pendingNewSession = pending;
}

/**
 * Discard the current draft (pending session that hasn't sent its first
 * message yet). If the user is still viewing the draft pane, also clear it.
 * If they've navigated to another session, leave that pane alone — just drop
 * the pending state and refresh the sidebar.
 *
 * Safe to call on `firstMessageSent === true` too (used by close-session-btn
 * during pending-pane lifetime), but in that case start_session is in flight
 * and the renderer will catch up.
 */
export function discardDraft(pane: HTMLElement): void {
  const pending = state.pendingNewSession;
  if (!pending) return;
  const wasOnDraft = state.selectedId === pending.placeholderId;
  state.pendingNewSession = null;
  clearPendingSession();
  discardComposerDraft(pending.placeholderId);
  void cancelOwnedSchedule(pending.placeholderId);

  if (wasOnDraft) {
    state.statusbar?.destroy();
    state.statusbar = null;
    if (state.renderer?.currentSessionId() === pending.placeholderId) {
      state.renderer.detach();
      state.renderer = null;
    }
    state.composer?.destroy();
    state.composer = null;
    setActiveSession(null);
    pane.innerHTML = paneEmptyStateHtml(state.daemonConnected, state.daemonSetupStalled);
  }

  const root = document.querySelector<HTMLElement>(".view-sessions");
  if (root) {
    const listEl = root.querySelector<HTMLElement>("#sessions-list");
    if (listEl) renderSidebar(listEl);
  }
}

/**
 * Re-open the current draft pending pane (used when the user has navigated
 * to another chat and clicks the draft row to come back). Tears down whatever
 * is currently in the pane and re-renders the pending pane with the original
 * placeholder + project + config. Textarea content is not preserved.
 *
 * No-op if there is no pending session or if the first message has already
 * been sent (in which case the row is "starting…", not a clickable draft).
 */
export async function resumeDraft(pane: HTMLElement): Promise<void> {
  const pending = state.pendingNewSession;
  if (!pending || pending.firstMessageSent) return;
  if (state.selectedId === pending.placeholderId) {
    // On mobile the back button hides the pane via CSS but leaves selectedId
    // intact. If we're in list mode, just switch back to the chat pane.
    const view = document.querySelector<HTMLElement>(".view-sessions");
    if (view?.getAttribute("data-mobile-pane") === "list") {
      view.setAttribute("data-mobile-pane", "chat");
    }
    return;
  }

  state.statusbar?.destroy();
  state.statusbar = null;
  state.renderer?.detach();
  state.renderer = null;
  state.composer?.destroy();
  state.composer = null;

  setActiveSession(pending.placeholderId);
  await renderPendingPane(
    pane,
    pending.placeholderId,
    { path: pending.projectPath, name: pending.projectName },
    pending.config,
    discardDraft,
  );

  const root = document.querySelector<HTMLElement>(".view-sessions");
  if (root) {
    const listEl = root.querySelector<HTMLElement>("#sessions-list");
    if (listEl) renderSidebar(listEl);
  }
}

export async function startNewSession(pane: HTMLElement): Promise<void> {
  const myMount = state.mountId;
  const project = await pickProject();
  if (!project) return;
  if (state.mountId !== myMount) return;
  const config = await openModelEffortModal(project.path, project.name);
  if (!config) return;
  if (state.mountId !== myMount) return;
  await launchNewSession(pane, project, config);
}

export async function launchNewSession(
  pane: HTMLElement,
  project: { path: string; name: string },
  config: SessionConfig,
): Promise<void> {
  // If there's an unsent draft, park it as a sidebar row the user can return
  // to or dismiss manually. If it already sent its first message ("starting...")
  // just drop the frontend tracking — the backend process keeps running and
  // will surface as a normal session row once SessionStarted fires.
  if (state.pendingNewSession) {
    if (!state.pendingNewSession.firstMessageSent) {
      const parked: ParkedDraft = {
        placeholderId: state.pendingNewSession.placeholderId,
        projectPath: state.pendingNewSession.projectPath,
        projectName: state.pendingNewSession.projectName,
        config: state.pendingNewSession.config,
      };
      state.parkedDrafts = [...state.parkedDrafts, parked];
    }
    state.pendingNewSession = null;
    clearPendingSession();
  }

  const placeholderId = makePlaceholderId();
  state.pendingNewSession = {
    placeholderId,
    projectPath: project.path,
    projectName: project.name,
    config,
    realId: null,
    firstMessageSent: false,
    preExistingSessionIds: new Set(state.sessions.map(s => s.session_id)),
    firstMessageSentAt: null,
  };
  savePendingSession(state.pendingNewSession);
  setActiveSession(placeholderId);

  await renderPendingPane(pane, placeholderId, project, config, discardDraft);

  // Re-render sidebar to show the pending row.
  const root = document.querySelector<HTMLElement>(".view-sessions");
  if (root) {
    // Mobile single-pane: a new draft reveals the chat pane (desktop ignores
    // this attribute — it only drives the ≤768px media query).
    root.setAttribute("data-mobile-pane", "chat");
    const listEl = root.querySelector<HTMLElement>("#sessions-list");
    if (listEl) renderSidebar(listEl);
  }
}

export { renderPendingPane } from "./pending-pane";
