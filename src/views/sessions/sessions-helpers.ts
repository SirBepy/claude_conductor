import type { Instance, ScheduledItem } from "../../types/ipc.generated";
import { markerToStatusClass } from "../../shared/status-icons";

export type SessionSort = "status" | "recent" | "name" | "drain";

export const LS_SORT = "cc_session_sort";
export const LS_UNREAD = "cc_session_unread";
export const LS_HIDDEN = "cc_hidden_sessions";
export const LS_HIDDEN_COLLAPSED = "cc_hidden_collapsed";
export const LS_HIDDEN_PROJECTS = "cc_hidden_projects";

export function projectName(i: Instance): string {
  const cwd = String(i.cwd ?? "");
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export function cwdToProjectName(cwd: string): string {
  const parts = String(cwd ?? "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/** Fallback title for a chat with no name yet - a live session before Claude
 *  names it, or a draft/parked row with no backing session at all. */
export const NO_NAME_TITLE = "New chat";

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
    return `<div class="session-empty">Select or create a session</div>`;
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
 * `Instance.jarvis` / `Instance.worker_of`. Joe's binding design decision:
 * Jarvis lives ONLY in its own dedicated window (see `open_jarvis_window`)
 * and must never appear in the Chats sidebar; a worker is meaningless to
 * browse outside its parent's context, so it's hidden the same way.
 *
 * Deliberately NOT applied to `state.sessions` itself (see `refreshSessions`
 * in `sidebar.ts`) - only to the LIST-BUILDING path in `renderSidebar`. The
 * Jarvis session's own detached window reuses the exact same `refreshSessions`
 * + `state.sessions` machinery to find and render itself
 * (`sessions.ts`'s `renderDetachedSession`: "We need state.sessions populated
 * so selectSession can find the entry"), so filtering it out of the shared
 * `state.sessions` array would break Jarvis's own window, not just hide it
 * from the sidebar list.
 */
export function isJarvisOrWorker(i: Instance): boolean {
  return i.jarvis === true || i.worker_of != null;
}

/**
 * Groups pending scheduled MESSAGE items by session_id, mirroring the exact
 * filter `scheduled-chip.ts` uses per-chat: `kind.type === "message"` and
 * status pending/firing (sent/failed excluded). `schedule_list` returns every
 * item across all sessions, so callers fetch ONCE and pass the full array
 * here rather than calling schedule_list per row. Purely a visual marker's
 * data source - does not feed statusPriority/sort.
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

/** Hover text for the sidebar row's scheduled-message marker. */
export function scheduledTooltip(count: number): string {
  return `${count} scheduled message${count === 1 ? "" : "s"}`;
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

/** 0=NeedsPermission, 1=Question, 2=Working, 3=Waiting(external process),
 * 4=Done(unread), 5=YourTurn, 6=External/Automated.
 * Question (Claude is waiting on the user) sorts above Working so idle-blocked
 * agents surface first for triage. Waiting (parked on a CI run / long command)
 * sorts just below Working and is its OWN tier - it used to share Working's
 * bucket, which hid the distinction between "actively running" and "blocked on
 * a script". `awaiting === "working"` (own background subagents/tasks still
 * running, will self-resume) is Working, NOT Waiting: from the user's
 * perspective the chat is still in progress. */
export function statusPriority(i: Instance, unread: Set<string>, attention: Set<string>, question: Set<string>): number {
  if (attention.has(i.session_id)) return 0;
  if (i.kind === "external" || i.kind === "automated") return 6;
  // Pending-prompt check (question OR permission-shaped, see `question`'s
  // construction in sidebar-entries.ts) must outrank the busy check - a
  // permission prompt never sets awaiting="question", so checking busy first
  // would misreport a session that's actually blocked on the user as "working".
  if (question.has(i.session_id)) return 1;
  if (i.busy && i.awaiting !== "question") return 2;
  // Background subagents/tasks of this session still running: still working.
  if (i.awaiting === "working") return 2;
  // Parked on an external process (CI / long command): its own status tier.
  if (i.awaiting === "waiting") return 3;
  if (unread.has(i.session_id)) return 4;
  return 5;
}

export function stateTooltip(i: Instance, unread: Set<string>, attention: Set<string>, question: Set<string>, rateLimited: ReadonlySet<string> = new Set()): string {
  if (attention.has(i.session_id)) return "Needs your permission - click to answer";
  if (i.kind === "external") return "External session (read-only)";
  if (i.kind === "automated") return "Automated session (remote-controlled)";
  if (i.busy && i.awaiting !== "question") return "Claude is running";
  if (question.has(i.session_id)) return "Claude asked a question - click to answer";
  if (i.awaiting === "working") return "Working in the background (subagents / tasks running)";
  if (i.awaiting === "waiting") return "Waiting on an external process (CI / a long command)";
  if (i.awaiting === "close_failed") return "Close did not confirm - the chat may still be open";
  if (rateLimited.has(i.session_id)) return "Usage limit reached - will auto-resume on reset";
  if (unread.has(i.session_id)) return "Claude responded - click to read";
  return "Done - your turn";
}

/** Maps a session to its display segment index.
 *  0=Input Needed, 1=Done, 2=In Progress, 3=Closing, 4=Waiting for Reset,
 *  5=Waiting (external process), 6=Scheduled (pending scheduled msg, not
 *  Input Needed/Done), 7=Remote (is_remote, wins over every other state -
 *  the row's own status dot still conveys the real state).
 *  Closing and rate-limited both still win over Scheduled. `frozen` is a row
 *  chip now (`frozenBadgeHtml`), not a segment - see sidebar-row-visuals.ts. */
export function sessionSegment(
  s: Instance,
  unread: Set<string>,
  attention: Set<string>,
  question: Set<string>,
  closing: Set<string>,
  rateLimited: ReadonlySet<string> = new Set(),
  scheduled: ReadonlySet<string> = new Set(),
): number {
  if (s.is_remote) return 7;
  if (closing.has(s.session_id)) return 3;
  if (rateLimited.has(s.session_id)) return 4;
  const priority = statusPriority(s, unread, attention, question);
  if (priority === 0 || priority === 1) return 0; // Input Needed
  if (priority === 4 || priority === 5) return 1; // Done
  if (scheduled.has(s.session_id)) return 6; // Scheduled
  if (priority === 2 || priority === 6) return 2; // In Progress (busy + external/automated)
  return 5; // Waiting on an external process (CI / long command)
}

export function sortSessions(
  sessions: Instance[],
  sort: SessionSort,
  closing: Set<string> = new Set(),
  drainBySession?: Map<string, number>,
): Instance[] {
  const copy = sessions.slice();
  const closingLast = (a: Instance, b: Instance): number => {
    const ac = closing.has(a.session_id) ? 1 : 0;
    const bc = closing.has(b.session_id) ? 1 : 0;
    return ac - bc;
  };
  if (sort === "drain") {
    // Heaviest 5h-quota drainer floats to the top. Unknown drain (no data yet)
    // sinks to the bottom; stable-tiebreak by most-recent like the other sorts.
    return copy.sort((a, b) => {
      const cl = closingLast(a, b);
      if (cl !== 0) return cl;
      const da = drainBySession?.get(a.session_id) ?? -1;
      const db = drainBySession?.get(b.session_id) ?? -1;
      if (da !== db) return db - da;
      return (b.started_at ?? "").localeCompare(a.started_at ?? "");
    });
  }
  if (sort === "name") {
    return copy.sort((a, b) =>
      closingLast(a, b) ||
      projectName(a).localeCompare(projectName(b), undefined, { sensitivity: "base" })
    );
  }
  if (sort === "recent") {
    return copy.sort((a, b) =>
      closingLast(a, b) ||
      (b.started_at ?? "").localeCompare(a.started_at ?? "")
    );
  }
  // status sort: segment/header placement (sessionSegment) already buckets by
  // status/unread elsewhere - ordering WITHIN a bucket is project name asc,
  // then creation order (started_at asc, oldest first). Read/unread must not
  // affect order, so statusPriority is deliberately not consulted here.
  return copy.sort((a, b) => {
    const cl = closingLast(a, b);
    if (cl !== 0) return cl;
    const pn = projectName(a).localeCompare(projectName(b), undefined, { sensitivity: "base" });
    if (pn !== 0) return pn;
    return (a.started_at ?? "").localeCompare(b.started_at ?? "");
  });
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

export function loadHiddenSessions(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_HIDDEN);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* ignore */ }
  return new Set();
}

export function saveHiddenSessions(set: Set<string>): void {
  try { localStorage.setItem(LS_HIDDEN, JSON.stringify([...set])); }
  catch { /* ignore */ }
}

/** Projects (keyed by cwd, matching the alias/merge system's own key) hidden
 *  from the sidebar entirely via the project-rail filter. Independent of the
 *  per-session hide list above: a hidden project's chats never show anywhere,
 *  including in the "Hidden" section. */
export function loadHiddenProjects(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_HIDDEN_PROJECTS);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* ignore */ }
  return new Set();
}

export function saveHiddenProjects(set: Set<string>): void {
  try { localStorage.setItem(LS_HIDDEN_PROJECTS, JSON.stringify([...set])); }
  catch { /* ignore */ }
}

export function loadHiddenCollapsed(): boolean {
  try {
    const v = localStorage.getItem(LS_HIDDEN_COLLAPSED);
    if (v !== null) return v === "true";
  } catch { /* ignore */ }
  return true;
}

export function saveHiddenCollapsed(collapsed: boolean): void {
  try { localStorage.setItem(LS_HIDDEN_COLLAPSED, collapsed ? "true" : "false"); }
  catch { /* ignore */ }
}

// ── Per-segment collapse state (in-memory only, resets to default on section disappear) ──
// Segments collapsed by default: 3 = Closing, 6 = Scheduled, 7 = Remote
const SEG_DEFAULT_COLLAPSED = new Set([3, 6, 7]);
const segCollapseOverrides = new Map<number, boolean>();

export function isSegCollapsed(seg: number): boolean {
  if (segCollapseOverrides.has(seg)) return segCollapseOverrides.get(seg)!;
  return SEG_DEFAULT_COLLAPSED.has(seg);
}

export function toggleSegCollapse(seg: number): void {
  segCollapseOverrides.set(seg, !isSegCollapsed(seg));
}

export function resetSegCollapse(seg: number): void {
  segCollapseOverrides.delete(seg);
}

export function loadSort(): SessionSort {
  try {
    const v = localStorage.getItem(LS_SORT);
    if (v === "status" || v === "recent" || v === "name" || v === "drain") return v;
  } catch { /* ignore */ }
  return "status";
}

export function saveSort(v: SessionSort): void {
  try { localStorage.setItem(LS_SORT, v); }
  catch { /* ignore */ }
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
  if (attention.has(i.session_id)) return "st-attention";
  if (i.kind === "external" || i.kind === "automated") return "st-external";
  // Same ordering fix as statusPriority: pending-prompt outranks busy.
  if (question.has(i.session_id)) return markerToStatusClass("question");
  if (i.busy && i.awaiting !== "question") return markerToStatusClass("working");
  if (i.awaiting === "working") return markerToStatusClass("working");
  if (i.awaiting === "waiting") return markerToStatusClass("waiting");
  if (i.awaiting === "close_failed") return markerToStatusClass("close_failed");
  if (rateLimited.has(i.session_id)) return "st-rate-limited";
  if (unread.has(i.session_id)) return "st-done";
  return markerToStatusClass("done");
}
