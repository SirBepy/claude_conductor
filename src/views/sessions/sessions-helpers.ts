import type { Instance, ScheduledItem } from "../../types/ipc.generated";
import { markerToStatusClass } from "../../shared/status-icons";
import { isNoProjectPath, NO_PROJECT_LABEL } from "../../shared/no-project";
import { whatsNewHtml } from "./whats-new/whats-new";


const LS_UNREAD = "cc_session_unread";
const LS_HIDDEN = "cc_hidden_sessions";

export function projectName(i: Instance): string {
  return cwdToProjectName(String(i.cwd ?? ""));
}

export function cwdToProjectName(cwd: string): string {
  if (isNoProjectPath(cwd)) return NO_PROJECT_LABEL;
  const parts = String(cwd ?? "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/** Fallback title for a chat with no name yet - a live session before Claude
 *  names it, or a draft/parked row with no backing session at all. */
const NO_NAME_TITLE = "New chat";

export function sessionSubtitle(i: Instance): string {
  return i.name || NO_NAME_TITLE;
}

/**
 * The pane's empty-state markup (nothing selected). Doubles as the daemon
 * boot indicator: while the daemon is not connected the CENTER of the screen
 * shows an animated "Setting up..." (or the stalled warning), not the
 * sidebar - the sidebar stays blank until the daemon is reachable.
 */
export function paneEmptyStateHtml(connected: boolean | null, stalled: boolean): string {
  if (connected === true) {
    return `<div class="session-empty session-empty--home"><div class="session-empty-line">Select or create a session</div>${whatsNewHtml()}</div>`;
  }
  if (stalled) {
    return `<div class="session-empty session-empty--setup session-empty--stalled"><i class="ph ph-warning"></i><span>Daemon unreachable, retrying. See daemon.log if this persists.</span></div>`;
  }
  return `<div class="session-empty session-empty--setup"><i class="ph ph-spinner"></i><span>Setting up...</span></div>`;
}

/**
 * Single source of truth for "Claude asked a question" per session: the
 * registry's `awaiting` field, set by the daemon from the turn's result-line
 * marker and (durably, mid-turn) by the AskUserQuestion hook. The old second
 * source - a frontend in-memory set fed by the active renderer's marker
 * detection - could only ever update whichever chat was open, so backgrounded
 * chats kept stale "Input needed" flags (or missed real ones) until reopened.
 * Every consumer (sidebar rows, header avatar ring, held-message flush gate)
 * derives from this ONE helper so they can never disagree.
 */
export function deriveQuestionSet(sessions: Instance[]): Set<string> {
  return new Set(sessions.filter((s) => s.awaiting === "question").map((s) => s.session_id));
}

/**
 * Jarvis (todo 272) and its worker sub-sessions, daemon-authoritative via
 * `Instance.jarvis` / `Instance.worker_of`. Jarvis is reached only through
 * the sidemenu's Jarvis entry (`open-jarvis.ts`: its own window on desktop,
 * the Chats pane on the phone) and must never appear in the Chats sidebar; a
 * worker is meaningless to browse outside its parent's context, so it's
 * hidden the same way.
 *
 * Deliberately NOT applied to `state.sessions` itself (see `refreshSessions`
 * in `sidebar.ts`) - only to the LIST-BUILDING path in `renderSidebar`. Both
 * Jarvis surfaces reuse the exact same `refreshSessions` + `state.sessions`
 * machinery to find and render it (`sessions.ts`'s `renderDetachedSession`:
 * "We need state.sessions populated so selectSession can find the entry"),
 * so filtering it out of the shared `state.sessions` array would break
 * Jarvis itself, not just hide it from the sidebar list.
 */
export function isJarvisOrWorker(i: Instance): boolean {
  return i.jarvis === true || i.worker_of != null;
}

/**
 * A hidden sub of a main chat (Use subchats): it has no sidebar row, no
 * Ctrl+N number and no place in any chat count, on any surface. Like
 * `isJarvisOrWorker` it is applied where a LIST of chats is built, never to
 * `state.sessions` itself, because the main chat's window opens a sub in place
 * and every by-id lookup (event store, composer, prompts) must still find it.
 * Remote lists keep sub rows, so the phone and a paired machine filter with
 * this same helper instead of the daemon stripping them (a stripped row would
 * orphan its parked prompt).
 */
export function isSubchat(i: Instance): boolean {
  return i.subchat_of != null;
}

/**
 * True when the chat is hosted on a paired peer machine (multi-machine
 * federation), the `Instance.machine` tag stamped only by
 * `daemon::machines::all_instances` / `MirrorState::instances`. Accepts a
 * nullable/undefined Instance because several call sites look up a session
 * by id from an array that may not have it (a draft, a session that closed).
 */
export function isMirrored(i: Instance | null | undefined): boolean {
  return i?.machine != null;
}

/**
 * Groups pending scheduled MESSAGE items by session_id, mirroring the exact
 * filter `scheduled-chip.ts` uses per-chat: `kind.type === "message"` and
 * status pending/firing (sent/failed excluded). `schedule_list` returns every
 * item across all sessions, so callers fetch ONCE and pass the full array
 * here rather than calling schedule_list per row. Purely a visual marker's
 * data source.
 */
export function scheduledCountsBySession(items: ScheduledItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const it of items) {
    if (it.kind.type !== "message") continue;
    if (it.status.type !== "pending" && it.status.type !== "firing") continue;
    const sid = it.kind.session_id;
    counts.set(sid, (counts.get(sid) ?? 0) + 1);
  }
  return counts;
}

/**
 * The set of draft `placeholderId`s that have a pending/firing scheduled
 * NewChat queued (tagged at creation in pending-pane.ts). The sidebar uses this
 * to HIDE a draft row until its scheduled spawn actually fires (ai_todo 322
 * item 6) - a draft the user has deferred shouldn't sit in the list labelled
 * "draft". Mirrors scheduledCountsBySession's filter, keyed on placeholder_id.
 */
export function scheduledPendingPlaceholderIds(items: ScheduledItem[]): Set<string> {
  const ids = new Set<string>();
  for (const it of items) {
    if (it.kind.type !== "new_chat") continue;
    if (it.status.type !== "pending" && it.status.type !== "firing") continue;
    if (it.kind.placeholder_id) ids.add(it.kind.placeholder_id);
  }
  return ids;
}

/**
 * Pending/firing scheduled NewChat ids owned by `placeholderId`. Recurring items
 * are excluded: a recurring NewChat outlives any single draft.
 */
export function ownedScheduledNewChatIds(items: ScheduledItem[], placeholderId: string): string[] {
  return items
    .filter((it) =>
      it.kind.type === "new_chat" &&
      it.kind.placeholder_id === placeholderId &&
      it.recurrence == null &&
      (it.status.type === "pending" || it.status.type === "firing")
    )
    .map((it) => it.id);
}

/** A frozen chat Joe never sees: the daemon froze it for sitting done or waiting on a question
 *  card, which is not a usage-limit freeze. Its head, menu and composer behave as if it were live;
 *  opening it or sending to it wakes it. The daemon says which kind it is (`idle_frozen`, set by
 *  the idle sweep and kept in step with its stored marks): the flags and the reset stamp cannot,
 *  because both freezes read `frozen && auto_frozen` and the stamp is wiped when any chat on the
 *  account finishes a turn. Anything without the marker is a usage-limit or manual freeze:
 *  opening one must show its choice card, not silently send "continue".
 *  Lives here, not in chat-heads-model.ts (which re-exports it), because chat-heads-model.ts
 *  already imports this file through project-main-chats.ts. */
export function isIdleFrozen(s: { frozen?: boolean; auto_frozen?: boolean; idle_frozen?: boolean | null }): boolean {
  // `auto_frozen` too: a manual freeze laid over a row whose marker was not cleared yet is not idle.
  return s.frozen === true && s.auto_frozen === true && s.idle_frozen === true;
}

export type SessionState =
  | "attention" | "external" | "automated" | "question"
  | "working" | "workingBg" | "waiting" | "unread" | "idle";

/** Precedence cascade behind statusDotClass.
 * Question outranks busy: a permission prompt never sets awaiting="question",
 * so a busy session with a pending permission prompt still needs input first. */
export function classifySessionState(
  i: Instance,
  unread: Set<string>,
  attention: Set<string>,
  question: Set<string>,
): SessionState {
  if (attention.has(i.session_id)) return "attention";
  if (i.kind === "external") return "external";
  if (i.kind === "automated") return "automated";
  if (question.has(i.session_id)) return "question";
  if (i.busy && i.awaiting !== "question") return "working";
  if (i.awaiting === "working") return "workingBg";
  if (i.awaiting === "waiting") return "waiting";
  if (unread.has(i.session_id)) return "unread";
  return "idle";
}

export function loadUnreadSet(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_UNREAD);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* ignore */ }
  return new Set();
}

export function saveUnreadSet(set: Set<string>): void {
  try { localStorage.setItem(LS_UNREAD, JSON.stringify([...set])); }
  catch { /* ignore */ }
}

/** The daemon owns the hidden list (hidden-sessions-sync.ts); localStorage is
 *  its last-known copy, read synchronously by every render so a reload never
 *  flashes hidden chats into the visible list before the daemon answers. */
export function loadHiddenSessions(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_HIDDEN);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* ignore */ }
  return new Set();
}

/** Overwrites the local copy only; the daemon's push lands here. */
export function writeHiddenSessionsLocal(set: Set<string>): void {
  try { localStorage.setItem(LS_HIDDEN, JSON.stringify([...set])); }
  catch { /* ignore */ }
}

export interface HiddenDelta {
  add?: string[];
  remove?: string[];
}
type HiddenPusher = (delta: HiddenDelta) => void;
let hiddenPusher: HiddenPusher | null = null;

/** Set by hidden-sessions-sync.ts, which owns the transport, so this file
 *  stays importable by tests and views that never talk to the daemon. */
export function setHiddenSessionsPusher(fn: HiddenPusher | null): void {
  hiddenPusher = fn;
}

function diff(prev: Set<string>, next: Set<string>): [string[], string[]] {
  return [[...next].filter((id) => !prev.has(id)), [...prev].filter((id) => !next.has(id))];
}

/** A user hide/unhide: updates the local copy at once and sends only the
 *  difference to the daemon, so a concurrent change made on another device
 *  is never reverted by this one's stale full set. */
export function saveHiddenSessions(set: Set<string>): void {
  const prev = loadHiddenSessions();
  writeHiddenSessionsLocal(set);
  const [add, remove] = diff(prev, set);
  if (add.length || remove.length) hiddenPusher?.({ add, remove });
}

/** The `st-*` status modifier for a session, driving the sidebar/header avatar
 * ring color. Marker classes (question/working/waiting/done) funnel through
 * markerToStatusClass; attention/external/rate-limited/unread are
 * statusDotClass-only states. */
export function statusDotClass(
  i: Instance,
  unread: Set<string>,
  attention: Set<string>,
  question: Set<string>,
  rateLimited: ReadonlySet<string> = new Set(),
): string {
  const state = classifySessionState(i, unread, attention, question);
  switch (state) {
    case "attention": return "st-attention";
    case "external": case "automated": return "st-external";
    case "question": return markerToStatusClass("question");
    case "working": case "workingBg": return markerToStatusClass("working");
    case "waiting": return markerToStatusClass("waiting");
    case "unread": case "idle":
      if (rateLimited.has(i.session_id)) return "st-rate-limited";
      return state === "unread" ? "st-done" : markerToStatusClass("done");
  }
}
