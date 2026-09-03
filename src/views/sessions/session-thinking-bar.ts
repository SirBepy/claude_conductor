import { state } from "./state";

let _progressN: number | null = null;
let _progressM: number = 0;
let _activity: string | null = null;
// True once the tool `_activity` describes has returned - see chat-renderer's
// activityIdle. Suffixes the label instead of blanking it back to generic
// "Thinking..." between a fast tool's result and the next tool/turn boundary.
let _activityIdle = false;
let _todoActivity: string | null = null;
let _pane: HTMLElement | null = null;

// How long the bare "Thinking…" branch may run with zero events before it
// admits the process is gone. Only that branch flips - a named tool or a
// 15-minute build is legitimate silence and keeps its own label.
const NOT_RESPONDING_MS = 120_000;
let _lastEventAt = 0;
let _wasBusy = false;
let _silenceTick: ReturnType<typeof setInterval> | null = null;

export function initThinkingBar(pane: HTMLElement | null): void {
  _pane = pane;
}

// Stamp that something arrived from the session, so the bar can tell a working
// turn apart from a dead process. Fed by the renderer's onLiveEvent hook.
export function noteThinkingEvent(): void {
  _lastEventAt = Date.now();
}

export function setThinkingActivity(s: string | null, idle = false): void {
  _activity = s;
  _activityIdle = idle;
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

/** Per-chat thinking-bar state, read off the ChatRenderer being mounted. */
export interface ThinkingBarSource {
  lastActivity: string | null;
  activityIdle: boolean;
  lastProgress: { n: number; m: number } | null;
  lastTodoActivity: string | null;
}

/** Repoint the bar at a newly mounted chat. Every field is overwritten, so a
 *  chat with no progress of its own blanks the previous chat's "Step N of M"
 *  instead of inheriting it - the module state below is global to the pane. */
export function syncThinkingBar(src: ThinkingBarSource | null): void {
  _activity = src?.lastActivity ?? null;
  _activityIdle = src?.activityIdle ?? false;
  _progressN = src?.lastProgress?.n ?? null;
  _progressM = src?.lastProgress?.m ?? 0;
  _todoActivity = src?.lastTodoActivity ?? null;
  // The incoming chat's silence is its own; never inherit the outgoing one's.
  _lastEventAt = Date.now();
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
  // Rising edge = a fresh turn, so silence is measured from here rather than
  // from whatever the previous turn last said.
  if (busy && !_wasBusy) _lastEventAt = Date.now();
  _wasBusy = busy;
  if (busy && _silenceTick === null) {
    _silenceTick = setInterval(updateThinkingBar, 5000);
  } else if (!busy && _silenceTick !== null) {
    clearInterval(_silenceTick);
    _silenceTick = null;
  }
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
    const frozen = !!state.sessions.find((s) => s.session_id === state.selectedId)?.frozen;
    if (!busy && hasHeld && frozen) textEl.textContent = "Frozen - will send once unfrozen";
    else if (_todoActivity !== null) textEl.textContent = _todoActivity;
    else if (_progressN !== null) textEl.textContent = `Step ${_progressN} of ${_progressM}`;
    else if (_activity) textEl.textContent = _activityIdle ? `${_activity} - thinking…` : _activity;
    else if (Date.now() - _lastEventAt > NOT_RESPONDING_MS) {
      textEl.textContent = "Not responding - no output from the session";
    } else textEl.textContent = "Thinking…";
  }
  state.heldMessages?.renderChip();
}
