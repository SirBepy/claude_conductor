import { state } from "./state";

let _progressN: number | null = null;
let _progressM: number = 0;
let _activity: string | null = null;
let _todoActivity: string | null = null;
let _pane: HTMLElement | null = null;

export function initThinkingBar(pane: HTMLElement | null): void {
  _pane = pane;
}

export function setThinkingActivity(s: string | null): void {
  _activity = s;
  if (s === null) {
    _progressN = null;
    _progressM = 0;
    _todoActivity = null;
  }
  updateThinkingBar();
}

export function setThinkingProgress(n: number, m: number): void {
  _progressN = n;
  _progressM = m;
  updateThinkingBar();
}

export function setThinkingTodoActivity(s: string | null): void {
  _todoActivity = s;
  updateThinkingBar();
}

// Mirrors sessions-helpers.ts statusPriority's In Progress tier: busy = a
// turn in flight, awaiting="working" = own background subagents/tasks still
// running. Keeps the bar and the sidebar spinner agreeing.
function isSessionActive(sessionId: string | null | undefined): boolean {
  const s = sessionId ? state.sessions.find(x => x.session_id === sessionId) : undefined;
  return !!s && (!!s.busy || s.awaiting === "working");
}

export function isCurrentSessionBusy(): boolean {
  const pending = state.pendingNewSession;
  if (pending) {
    // selectedId stays as placeholderId for the whole turn; only applies to
    // the pane that's actually showing the pending session.
    if (state.selectedId !== pending.placeholderId) {
      // User switched to a different session — check that session instead.
      return isSessionActive(state.selectedId);
    }
    if (pending.realId) {
      return isSessionActive(pending.realId);
    }
    // First message not yet sent = draft, no work in flight.
    if (!pending.firstMessageSent) return false;
    // First message sent, awaiting realId: show busy if placeholder active.
    return true;
  }
  return isSessionActive(state.selectedId);
}

export function updateThinkingBar(): void {
  const pane = _pane;
  if (!pane) return;
  const bar = pane.querySelector<HTMLElement>(".session-thinking");
  if (!bar) return;
  const busy = isCurrentSessionBusy();
  const hasHeld = !!state.heldMessages?.hasItemsForActive();
  const textEl = bar.querySelector<HTMLElement>(".thinking-text");
  bar.classList.toggle("busy", busy);
  // The header cancel button (pending pane) only belongs mid-turn; hide it while
  // drafting so "Cancel turn" never shows when there's no turn to cancel.
  const cancelBtn = pane.querySelector<HTMLButtonElement>(".cancel-btn");
  if (cancelBtn) cancelBtn.toggleAttribute("hidden", !busy);
  const pauseBtn = pane.querySelector<HTMLButtonElement>(".thinking-pause-btn");
  if (pauseBtn) pauseBtn.toggleAttribute("hidden", !(busy && !hasHeld));

  if (!busy && !hasHeld) {
    bar.setAttribute("hidden", "");
    if (textEl) textEl.textContent = "";
    state.heldMessages?.renderChip();
    return;
  }
  bar.removeAttribute("hidden");
  if (textEl) {
    if (_todoActivity !== null) textEl.textContent = _todoActivity;
    else if (_progressN !== null) textEl.textContent = `Step ${_progressN} of ${_progressM}`;
    else if (_activity) textEl.textContent = _activity;
    else textEl.textContent = "Thinking…";
  }
  state.heldMessages?.renderChip();
}
