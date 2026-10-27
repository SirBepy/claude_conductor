/**
 * Session-control API: queue functions, select/close shortcuts.
 * Extracted from sessions.ts so keyboard/IPC callers can import without
 * pulling in the full view-mount module.
 */

import { state } from "./state";
import { selectSession } from "./active-session";
import { startNewSession, startNewSessionWithFavorite, resumeDraft, resumeParkedDraft } from "./pending-flow";
import { saveParkedDrafts } from "./pending-draft-storage";
import { updateThinkingBar } from "./session-thinking-bar";
import { showView } from "../../shared/navigation";
import { closeChatWithConfirm } from "./close-chat";
import { askConfirm } from "../../shared/confirm";
import type { SessionConfig } from "../../shared/effort-presets";
import { isWrapUpOnDone, setWrapUpOnDone, rerenderSidebar } from "./permission-modal";
import { refreshWrapUpIndicator, projectDashboardOpener } from "./session-header";
import { openDashboardPage } from "./project-dashboard/dashboard-page";

// ── Shared pane + pending state ───────────────────────────────────────────────
// Written by sessions.ts via the setters below; read by the control functions.

let _pane: HTMLElement | null = null;
let _pendingOpenPicker = false;
let _pendingFavoriteSlot: number | null = null;
let _pendingHistoryResume: string | null = null;
let _pendingNewChat: { project: { path: string; name: string }; config: SessionConfig } | null = null;
let _pendingDashboard: { cwd: string; projectId: string | null } | null = null;

export function setPaneRef(pane: HTMLElement | null): void { _pane = pane; }

export function consumePendingOpenPicker(): boolean {
  const v = _pendingOpenPicker;
  _pendingOpenPicker = false;
  return v;
}

export function consumePendingFavoriteSlot(): number | null {
  const v = _pendingFavoriteSlot;
  _pendingFavoriteSlot = null;
  return v;
}

export function consumePendingHistoryResume(): string | null {
  const v = _pendingHistoryResume;
  _pendingHistoryResume = null;
  return v;
}

export function consumePendingDashboard(): { cwd: string; projectId: string | null } | null {
  const v = _pendingDashboard;
  _pendingDashboard = null;
  return v;
}

export function consumePendingNewChat(): { project: { path: string; name: string }; config: SessionConfig } | null {
  const v = _pendingNewChat;
  _pendingNewChat = null;
  return v;
}

// ── Queue functions ───────────────────────────────────────────────────────────

export function queueHistoryResume(sessionId: string): void {
  _pendingHistoryResume = sessionId;
}

/**
 * Select an already-live session on the next Sessions-view mount. Used by the
 * chats-window cross-window open request and open-jarvis. Functionally the
 * same select-on-mount as history-resume (both target a session that's live in
 * the registry).
 */
export function queueSessionSelect(sessionId: string): void {
  _pendingHistoryResume = sessionId;
}

/**
 * Open a live chat by session id from outside the Sessions view (the Android
 * shell's notification tap). Mounted: select it in the existing pane. Not
 * mounted: queue it for the next mount, which the view switch triggers.
 */
export function openChatById(sessionId: string): void {
  showView("sessions");
  if (_pane) {
    void selectSession(sessionId, _pane).then(updateThinkingBar);
  } else {
    queueSessionSelect(sessionId);
  }
}

/**
 * Launch a brand-new chat for a known project on the next Sessions-view mount.
 * The project + model/effort config are resolved by the caller (e.g. the
 * project-detail "+" button) so no project-picker is shown here.
 */
export function queueNewChat(project: { path: string; name: string }, config: SessionConfig): void {
  _pendingNewChat = { project, config };
}

/** Show a repo's dashboard page (its group's, when it has one): from the chat
 *  header's project name, the chat menu, Ctrl+Shift+D, or the Home screen via
 *  the Chats window's cross-window request. Not mounted: queued for the next mount. */
export function openProjectDashboard(cwd: string, projectId: string | null = null): void {
  showView("sessions");
  if (_pane) void openDashboardPage(cwd, projectId);
  else _pendingDashboard = { cwd, projectId };
}

/** Ctrl+Shift+D: the open chat's project. A draft already shows its dashboard, so it is left alone. */
export function openFocusedChatDashboard(): void {
  const id = state.selectedId;
  if (!id || state.pendingNewSession?.placeholderId === id) return;
  const s = state.sessions.find((x) => x.session_id === id);
  // The header's opener already refuses a mirrored chat, whose cwd is a path on another machine.
  if (!s || !projectDashboardOpener(s)) return;
  openProjectDashboard(String(s.cwd), s.project_id || null);
}

// ── Global triggers ───────────────────────────────────────────────────────────

export function triggerNewSessionGlobal(): void {
  if (_pane) {
    void startNewSession(_pane);
  } else {
    _pendingOpenPicker = true;
    showView("sessions");
  }
}

/** Ctrl+Shift+1..9 global shortcut: same pane-not-mounted fallback as
 *  triggerNewSessionGlobal, queued separately since it carries a slot. */
export function triggerNewSessionFavoriteGlobal(slot: number): void {
  if (_pane) {
    void startNewSessionWithFavorite(_pane, slot);
  } else {
    _pendingFavoriteSlot = slot;
    showView("sessions");
  }
}

// ── Keyboard shortcut handlers ────────────────────────────────────────────────

/**
 * Ctrl+Num in auto-slot mode. `state.sortedSessionIds` (built by
 * buildSidebarEntries) interleaves draft-row placeholder ids ahead of real
 * session ids, in the same order they're visually numbered - so an index can
 * resolve to either kind. Draft/parked resume mirrors the sidebar's own
 * click handlers (sessions-dom-wiring.ts) rather than re-deriving the logic.
 */
export function selectSessionByIndex(index: number): void {
  const pane = _pane;
  if (!pane) return;
  const id = state.sortedSessionIds[index];
  if (!id) return;

  const pending = state.pendingNewSession;
  if (pending?.placeholderId === id) {
    if (pending.firstMessageSent) {
      const realId = pending.realId;
      if (!realId) return;
      void (async () => {
        await selectSession(realId, pane);
        updateThinkingBar();
      })();
      return;
    }
    void resumeDraft(pane).then(updateThinkingBar);
    return;
  }

  const parked = state.parkedDrafts.find(d => d.placeholderId === id);
  if (parked) {
    state.parkedDrafts = state.parkedDrafts.filter(d => d.placeholderId !== parked.placeholderId);
    saveParkedDrafts(state.parkedDrafts);
    void (async () => {
      await resumeParkedDraft(pane, parked);
      updateThinkingBar();
    })();
    return;
  }

  void selectSession(id, pane);
}

/** Ctrl+W on a not-yet-sent draft: closeChatWithConfirm's clear_session call
 *  is a no-op here (no real session exists yet for the placeholder id), so it
 *  never reached the "discard-pending-draft" path the X button and 3-dot menu
 *  use - route there instead, same confirm the shortcut always shows. */
function closeFocusedDraft(): void {
  void (async () => {
    const ok = await askConfirm("Close this chat?", { confirmLabel: "Close", focusConfirm: true });
    if (!ok) return;
    document.dispatchEvent(new CustomEvent("discard-pending-draft"));
  })();
}

export function closeFocusedChat(): void {
  const id = state.selectedId;
  if (!id) return;
  if (state.pendingNewSession?.placeholderId === id) {
    closeFocusedDraft();
    return;
  }
  void closeChatWithConfirm(id);
}

/** Ctrl+Shift+W: flips "Wrap up when done" for the focused chat. A no-op on
 *  a not-yet-sent draft (no `session_id` to persist against yet) - same gate
 *  as the chat menu's own item. */
export function toggleWrapUpOnDoneForFocusedChat(): void {
  const id = state.selectedId;
  if (!id || state.pendingNewSession?.placeholderId === id) return;
  const next = !isWrapUpOnDone(id);
  setWrapUpOnDone(id, next);
  refreshWrapUpIndicator(state.selectedId, id, next);
  rerenderSidebar();
}
