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
import { invoke } from "../../shared/ipc";
import { showView } from "../../shared/navigation";
import type { SessionConfig } from "./model-effort-modal";

// ── Shared pane + pending state ───────────────────────────────────────────────
// Written by sessions.ts via the setters below; read by the control functions.

let _pane: HTMLElement | null = null;
let _pendingOpenPicker = false;
let _pendingFavoriteSlot: number | null = null;
let _pendingHistoryResume: string | null = null;
let _pendingNewChat: { project: { path: string; name: string }; config: SessionConfig } | null = null;

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
 * session-detail "Open in chats" CTA. Functionally the same select-on-mount as
 * history-resume (both target a session that's live in the registry).
 */
export function queueSessionSelect(sessionId: string): void {
  _pendingHistoryResume = sessionId;
}

/**
 * Launch a brand-new chat for a known project on the next Sessions-view mount.
 * The project + model/effort config are resolved by the caller (e.g. the
 * project-detail "+" button) so no project-picker is shown here.
 */
export function queueNewChat(project: { path: string; name: string }, config: SessionConfig): void {
  _pendingNewChat = { project, config };
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

export function closeFocusedChat(): void {
  const id = state.selectedId;
  if (!id) return;
  const sess = state.sessions.find(s => s.session_id === id);
  if (!sess?.busy) return;
  void invoke<void>("cancel_turn", { sessionId: id });
}
