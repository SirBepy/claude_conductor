import { state } from "./state";
import { visibleInterval } from "../../shared/visible-interval";
import { escapeHtml } from "../../shared/escape-html";
import { capActivityText, type ActivityDetail } from "../../shared/chat/tool-meta";
import { refreshNextChips } from "./next-chip-strip";
import { formatElapsed } from "../../shared/time";
import { turnCounts, type TurnAction } from "../../shared/chat/dashboard/dashboard-model";

/** The bar's markup, one copy for the established pane and the draft pane. The
 *  line is a button (it opens the detail block, the only route to Stop on a
 *  phone); Stop sits in the elapsed time's slot and replaces it on hover. */
export function thinkingBarHtml(): string {
  return (
    `<div class="session-thinking" hidden>` +
    `<div class="thinking-detail" hidden></div>` +
    `<div class="thinking-row">` +
    `<button type="button" class="thinking-main" aria-expanded="false" disabled>` +
    `<i class="ph thinking-icon" hidden></i><span class="thinking-text"></span><i class="ph ph-caret-up thinking-caret"></i></button>` +
    `<span class="thinking-slot"><span class="thinking-elapsed"></span>` +
    `<button type="button" class="thinking-pause-btn" title="Stop turn" hidden><i class="ph ph-stop-circle"></i>Stop</button></span>` +
    `</div></div>`
  );
}

/** Opens/closes the detail block on a click of the line, copies its text, and
 *  routes both Stop buttons to `onStop`. Delegated, so the re-rendered block
 *  needs no rewiring. */
export function wireThinkingBar(pane: HTMLElement, onStop: () => void): void {
  const bar = pane.querySelector<HTMLElement>(".session-thinking");
  if (!bar) return;
  bar.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest(".thinking-pause-btn, .thinking-stop-turn")) {
      onStop();
    } else if (t.closest(".thinking-copy")) {
      const text = _src?.lastActivityDetail?.text;
      if (text) void navigator.clipboard.writeText(text);
    } else if (t.closest(".thinking-main:not(:disabled)")) {
      bar.classList.toggle("is-open");
      updateThinkingBar();
    }
  });
}

let _src: ThinkingBarSource | null = null;
// When each chat's current busy stretch began, by session id. Per session and
// only written on the idle-to-busy edge, because the bar is re-synced on every
// chat switch and a single global stamp restarted the clock each time a
// still-busy chat was returned to.
const _busySinceById = new Map<string, number>();
let _elapsedTick: (() => void) | null = null;
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
let _silenceTick: (() => void) | null = null;

export function initThinkingBar(pane: HTMLElement | null): void {
  // Teardown passes null while a turn may still be busy. updateThinkingBar
  // returns early on a missing pane, so it can never disarm the timer itself.
  if (_silenceTick !== null) {
    _silenceTick();
    _silenceTick = null;
  }
  if (_elapsedTick !== null) {
    _elapsedTick();
    _elapsedTick = null;
  }
  _wasBusy = false;
  _src = null;
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
  /** Optional: the live renderer carries both, a plain snapshot (tests) may not. */
  lastActivityDetail?: ActivityDetail | null;
  /** When the in-flight turn began (ms), 0 while unknown. */
  activeTurnStartedAtMs?: number;
  /** The turn's tool calls so far (the dashboard's opened block lists them). */
  turnActions?: readonly TurnAction[];
}

/** The chat dashboard moves this bar into its Plan card, where the plan already
 *  shows the step: there the line says what Claude is doing right now (reading a
 *  file, running a command), with the tool's icon, and its opened block counts
 *  the turn's calls and lists the latest ones. */
function inDashboard(pane: HTMLElement): boolean {
  return pane.getAttribute("data-chat-view") === "dashboard";
}

/** The icon of the call the line describes, or a quiet default. */
function activityIcon(): string {
  const last = _src?.turnActions?.at(-1);
  if (_activity && last && last.label === _activity) return last.icon;
  return _activity ? "ph-wrench" : "ph-sparkle";
}

function agoText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

/** Repoint the bar at a newly mounted chat. Every field is overwritten, so a
 *  chat with no progress of its own blanks the previous chat's "Step N of M"
 *  instead of inheriting it - the module state below is global to the pane. */
export function syncThinkingBar(src: ThinkingBarSource | null): void {
  // Kept by reference: the live renderer mutates its detail and turn start as
  // events arrive, and the bar reads them at paint time instead of a callback each.
  _src = src;
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
    // A spawn that rejects, or resolves with no id, is rolled back to a draft
    // at the send site in pending-pane.ts. This bound is the remaining case
    // that site cannot see: an invoke that never settles at all. Same
    // NOT_RESPONDING_MS the established-session path below uses, so a pending
    // row goes quiet on the same silence budget as any other.
    if (pending.firstMessageSentAt !== null && Date.now() - pending.firstMessageSentAt > NOT_RESPONDING_MS) {
      return false;
    }
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
  trackBusySince(busy);
  if (busy && _silenceTick === null) {
    _silenceTick = visibleInterval(updateThinkingBar, 5000);
  } else if (!busy && _silenceTick !== null) {
    _silenceTick();
    _silenceTick = null;
  }
  // A second timer, not a faster silence tick: this one only rewrites the
  // clock's text, where updateThinkingBar also redraws chips and the label.
  if (busy && _elapsedTick === null) {
    _elapsedTick = visibleInterval(paintElapsed, 1000);
  } else if (!busy && _elapsedTick !== null) {
    _elapsedTick();
    _elapsedTick = null;
  }
  const hasHeld = !!state.heldMessages?.hasItemsForActive();
  // Before the idle early return below: an idle, empty bar is exactly when the
  // quick-reply chips show.
  refreshNextChips(pane);
  const textEl = bar.querySelector<HTMLElement>(".thinking-text");
  const dash = inDashboard(pane);
  bar.classList.toggle("busy", busy);
  // The header cancel button (pending pane) only belongs mid-turn; hide it while
  // drafting so "Cancel turn" never shows when there's no turn to cancel.
  const cancelBtn = pane.querySelector<HTMLButtonElement>(".cancel-btn");
  if (cancelBtn) cancelBtn.toggleAttribute("hidden", !busy);
  const pauseBtn = pane.querySelector<HTMLButtonElement>(".thinking-pause-btn");
  // While messages are held the list's "Interrupt & send" is the interrupt, so Stop
  // would be a second, competing way to end the same turn.
  const showStop = busy && !hasHeld;
  if (pauseBtn) pauseBtn.toggleAttribute("hidden", !showStop);
  const mainBtn = bar.querySelector<HTMLButtonElement>(".thinking-main");
  if (mainBtn) mainBtn.disabled = !busy;

  if (!busy && !hasHeld) {
    bar.setAttribute("hidden", "");
    if (textEl) textEl.textContent = "";
    renderDetail(bar, false, false, dash);
    state.heldMessages?.renderChip();
    return;
  }
  bar.removeAttribute("hidden");
  if (textEl) {
    const frozen = !!state.sessions.find((s) => s.session_id === state.selectedId)?.frozen;
    // Reaching here while idle means the bar is up only to anchor the held list
    // (the early return above covers idle-and-empty), so every label below it
    // describes a turn that is not running - `_activity` especially, which
    // keeps the last tool name and reads as "<tool>... - thinking…".
    const silent = Date.now() - _lastEventAt > NOT_RESPONDING_MS;
    if (!busy) textEl.textContent = frozen ? "Frozen - will send once unfrozen" : "Waiting to send";
    else if (dash) {
      if (_activity) textEl.textContent = _activityIdle ? `${_activity} - thinking…` : _activity;
      else textEl.textContent = silent ? "Not responding - no output from the session" : "Thinking…";
    } else if (_todoActivity !== null) textEl.textContent = _todoActivity;
    else if (_progressN !== null) textEl.textContent = `Step ${_progressN} of ${_progressM}`;
    else if (_activity) textEl.textContent = _activityIdle ? `${_activity} - thinking…` : _activity;
    else if (silent) {
      textEl.textContent = "Not responding - no output from the session";
    } else textEl.textContent = "Thinking…";
  }
  const icon = bar.querySelector<HTMLElement>(".thinking-icon");
  if (icon) {
    icon.hidden = !(dash && busy);
    if (dash && busy) icon.className = `ph thinking-icon ${activityIcon()}`;
  }
  renderDetail(bar, busy, showStop, dash);
  paintElapsed();
  state.heldMessages?.renderChip();
}

/** Stamps the selected chat's busy-since the first time it is seen busy and
 *  drops it once it is seen idle. Other chats whose session row says they went
 *  idle while away are dropped too, so their next turn gets a fresh stamp; a
 *  key with no session row (a pending placeholder) is left alone. */
function trackBusySince(busy: boolean): void {
  const id = state.selectedId;
  if (id) {
    if (!busy) _busySinceById.delete(id);
    else if (!_busySinceById.has(id)) _busySinceById.set(id, Date.now());
  }
  for (const known of _busySinceById.keys()) {
    if (known !== id && state.sessions.some(s => s.session_id === known) && !isSessionActive(known)) {
      _busySinceById.delete(known);
    }
  }
}

function paintElapsed(): void {
  const bar = _pane?.querySelector<HTMLElement>(".session-thinking");
  if (!bar) return;
  // The renderer's own turn start survives a chat switch; the per-chat
  // busy-since is the fallback while a turn has no recorded start of its own.
  const start = _src?.activeTurnStartedAtMs
    || (state.selectedId ? _busySinceById.get(state.selectedId) : undefined)
    || Date.now();
  const text = _wasBusy ? formatElapsed(Date.now() - start) : "";
  for (const n of bar.querySelectorAll<HTMLElement>(".thinking-elapsed")) n.textContent = text;
  const now = Date.now();
  for (const n of bar.querySelectorAll<HTMLElement>(".thinking-ago[data-at]")) n.textContent = agoText(now - Number(n.dataset.at));
}

/** The opened block: the full command or path, then tool, time, step. Redrawn only
 *  when its content changes, so a text selection inside it survives the stream. */
function renderDetail(bar: HTMLElement, busy: boolean, showStop: boolean, dash = false): void {
  if (!busy) bar.classList.remove("is-open");
  const open = busy && bar.classList.contains("is-open");
  bar.querySelector(".thinking-main")?.setAttribute("aria-expanded", String(open));
  const host = bar.querySelector<HTMLElement>(".thinking-detail");
  if (!host) return;
  host.toggleAttribute("hidden", !open);
  if (!open) {
    delete host.dataset.key;
    return;
  }
  const d = _src?.lastActivityDetail ?? null;
  const step = _progressN !== null ? `Step ${_progressN} of ${_progressM}` : null;
  const actions = dash ? _src?.turnActions ?? [] : [];
  const key = JSON.stringify([d, step, _todoActivity, showStop, dash, actions.length, actions.at(-1)?.id ?? null]);
  if (host.dataset.key === key) return;
  host.dataset.key = key;
  if (dash) {
    host.innerHTML = dashDetailHtml(d, actions, showStop);
    paintElapsed();
    return;
  }
  host.innerHTML =
    (d?.text
      ? `<div class="thinking-cmd"><code>${escapeHtml(capActivityText(d.text))}</code><button type="button" class="thinking-copy" title="Copy"><i class="ph ph-copy"></i></button></div>`
      : "") +
    `<div class="thinking-meta">` +
    (d ? `<span><i class="ph ph-wrench"></i>${escapeHtml(d.tool)}</span>` : "") +
    `<span><i class="ph ph-timer"></i><span class="thinking-elapsed"></span></span>` +
    (step ? `<span><i class="ph ph-list-checks"></i>${escapeHtml(step)}</span>` : "") +
    (_todoActivity ? `<span><i class="ph ph-check-square"></i>${escapeHtml(_todoActivity)}</span>` : "") +
    `</div>` +
    (showStop ? `<button type="button" class="thinking-stop-turn"><i class="ph ph-stop-circle"></i>Stop turn</button>` : "");
}

/** The dashboard's opened block: the full command, the turn's calls counted by
 *  kind, and the few before the one on the line (the plan already says the step). */
function dashDetailHtml(d: ActivityDetail | null, actions: readonly TurnAction[], showStop: boolean): string {
  const cmd = d?.text
    ? `<div class="thinking-cmd"><code>${escapeHtml(capActivityText(d.text))}</code><button type="button" class="thinking-copy" title="Copy"><i class="ph ph-copy"></i></button></div>`
    : "";
  const counts = actions.length > 0
    ? `<div class="thinking-counts"><i class="ph ph-chart-bar"></i><span>This turn: ${escapeHtml(turnCounts(actions))}</span></div>` : "";
  const before = actions.length > 1 ? actions.slice(-4, -1).reverse() : [];
  const trail = before.length > 0
    ? `<div class="thinking-trail">${before.map((a) => `<div class="thinking-trail-row"><i class="ph ${escapeHtml(a.icon)}"></i><span>${escapeHtml(a.label)}</span><em class="thinking-ago" data-at="${a.at}"></em></div>`).join("")}</div>` : "";
  const stop = showStop ? `<button type="button" class="thinking-stop-turn"><i class="ph ph-stop-circle"></i>Stop turn</button>` : "";
  return `${cmd}${counts}${trail}${stop}`;
}
