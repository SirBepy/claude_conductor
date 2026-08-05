import { invoke } from "../../shared/ipc";
import { updateFaviconBadge } from "../../shared/favicon-badge";
import type { Instance, DrainBoard, ScheduledItem } from "../../types/ipc.generated";
import {
  loadUnreadSet,
  saveUnreadSet,
  scheduledCountsBySession,
  scheduledPendingPlaceholderIds,
} from "./sessions-helpers";
import { state } from "./state";
import { pendingPromptSessionIds, clearPendingPrompt } from "./permission-modal";
import { reconcileList, loadAnimEnabled } from "./sidebar-anim";
import { hydrateCharacterAvatars, hydrateProjectTechIcons } from "../../shared/projects";
import { setRerenderCallback } from "./sidebar-ctx-menu";
import { attachRowTooltips } from "../../shared/row-tooltip";
import { buildSidebarEntries } from "./sidebar-entries";
export { closeCtxMenu, openDraftCtxMenu, openCtxMenu } from "./sidebar-ctx-menu";

let sidebarListEl: HTMLElement | null = null;

// ── Shared debounced-refresh shape ───────────────────────────────────────────
//
// Both drain-map and scheduled-count refreshes solve the same problem:
// renderSidebar runs often and synchronously and must never block on an IPC
// call, so each optional per-row data source is fetched in the background,
// debounced, and only triggers a re-render if `fetchAndApply` says the fetch
// actually changed something worth showing.
/** Creates a `refresh(force?)` function that owns an in-flight guard and a
 *  debounce window around `fetchAndApply`. `fetchAndApply` performs the IPC
 *  call plus any map mutation and returns whether a re-render is warranted;
 *  errors are caught and logged with `label`, and the in-flight flag is
 *  always cleared in a `finally`. */
function createDebouncedRefresher(
  label: string,
  fetchAndApply: () => Promise<boolean>,
  debounceMs: number,
): (force?: boolean) => void {
  let inFlight = false;
  let lastFetchMs = 0;
  return (force = false): void => {
    if (inFlight) return;
    if (!force && Date.now() - lastFetchMs < debounceMs) return;
    inFlight = true;
    void (async () => {
      try {
        const shouldRerender = await fetchAndApply();
        lastFetchMs = Date.now();
        // Re-render with the fresh data. Guard on a still-mounted list element.
        if (shouldRerender && sidebarListEl) renderSidebar(sidebarListEl);
      } catch (err) {
        console.error(`[sidebar] ${label} failed`, err);
      } finally {
        inFlight = false;
      }
    })();
  };
}

// ── Token-drain data (for the "Token drain" sort) ────────────────────────────
//
// sessionId -> fiveHourPct (this chat's share of the current 5h session). Filled
// lazily by refreshDrainMap, which is ONLY kicked when the active sort is
// "drain". renderSidebar runs frequently and synchronously, so it must never
// block on (or unconditionally fire) the chat_drains IPC — it reads whatever
// drainMap already has and triggers an async, debounced background refresh.
const drainMap = new Map<string, number>();
const DRAIN_REFRESH_DEBOUNCE_MS = 3000;
let pendingDrainSessionIds: string[] = [];

const runDrainRefresh = createDebouncedRefresher("chat_drains", async () => {
  // Snapshot the id list: a refreshDrainMap() call landing while this fetch is
  // in flight overwrites pendingDrainSessionIds, and the apply loop must walk
  // the ids this fetch actually queried, not the newer set.
  const sessionIds = pendingDrainSessionIds;
  const board = await invoke<DrainBoard>("chat_drains", { sessionIds });
  for (const id of sessionIds) {
    const chat = board.chats[id];
    // null share = no usage snapshot yet; leave it out so the row keeps the
    // "—% of 5h" placeholder rather than rendering a misleading 0%.
    if (chat && chat.fiveHourPct !== null) drainMap.set(id, chat.fiveHourPct);
  }
  return true;
}, DRAIN_REFRESH_DEBOUNCE_MS);

/** Lazily refresh the per-session drain percentages, then re-render ONCE.
 *  Debounced: skips if a fetch is in flight or one ran within the last ~3s. */
function refreshDrainMap(sessionIds: string[]): void {
  if (sessionIds.length === 0) return;
  pendingDrainSessionIds = sessionIds;
  runDrainRefresh();
}

// ── Scheduled-message counts (sidebar marker + count badge) ─────────────────
//
// sessionId -> count of pending/firing scheduled MESSAGE items, mirroring
// scheduled-chip.ts's per-chat filter exactly. `schedule_list` returns EVERY
// item across all sessions, so this fetches ONCE per refresh and groups
// client-side (scheduledCountsBySession) rather than calling schedule_list
// per row. Refreshed on the sidebar's normal render cadence (debounced, same
// shape as drainMap above) and immediately on "scheduled-items-changed"
// (wired in sessions.ts via forceRefreshScheduledCounts) so the badge doesn't
// lag behind a schedule/cancel action taken in the open chat.
const scheduledCountMap = new Map<string, number>();
// Draft placeholderIds with a pending/firing scheduled NewChat - the sidebar
// hides those draft rows until the schedule fires (ai_todo 322 item 6).
const scheduledPendingPlaceholders = new Set<string>();
const SCHEDULED_REFRESH_DEBOUNCE_MS = 3000;

function scheduledCountMapsEqual(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [sid, n] of a) {
    if (b.get(sid) !== n) return false;
  }
  return true;
}

function stringSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

const runScheduledRefresh = createDebouncedRefresher("schedule_list", async () => {
  const all = await invoke<ScheduledItem[]>("schedule_list");
  // Defensive: schedule_list is contracted to return an array, but never
  // trust an IPC response shape blindly (a mocked/misbehaving transport
  // returning e.g. {} would make the grouping loop below throw).
  const arr = Array.isArray(all) ? all : [];
  const next = scheduledCountsBySession(arr);
  const nextPlaceholders = scheduledPendingPlaceholderIds(arr);
  // Only re-render if the counts OR the hidden-draft set actually changed - the
  // common case on every poll tick is "nothing scheduled changed", and
  // re-rendering unconditionally would fire a full sidebar re-render (and its
  // own recursive refreshScheduledCounts + hydrate passes) every cycle for no
  // visible difference.
  if (
    scheduledCountMapsEqual(scheduledCountMap, next) &&
    stringSetsEqual(scheduledPendingPlaceholders, nextPlaceholders)
  ) {
    return false;
  }
  scheduledCountMap.clear();
  for (const [sid, n] of next) scheduledCountMap.set(sid, n);
  scheduledPendingPlaceholders.clear();
  for (const pid of nextPlaceholders) scheduledPendingPlaceholders.add(pid);
  return true;
}, SCHEDULED_REFRESH_DEBOUNCE_MS);

function refreshScheduledCounts(force = false): void {
  runScheduledRefresh(force);
}

/** Recount immediately, bypassing the debounce - called on the
 *  "scheduled-items-changed" event so a schedule/cancel action in the open
 *  chat reflects in the sidebar right away instead of waiting out the
 *  debounce window. */
export function forceRefreshScheduledCounts(): void {
  refreshScheduledCounts(true);
}

export function isLive(i: Instance): boolean {
  return !i.ended_at && (i.kind === "interactive" || i.kind === "external" || i.kind === "automated");
}

/**
 * Re-fetch the live session list into `state.sessions`. Returns whether the
 * `list_instances` IPC actually succeeded: on failure the catch below empties
 * `state.sessions` (pre-existing behavior the sidebar render relies on), which
 * is indistinguishable from "everything genuinely ended" to callers that diff
 * the list - the event-store eviction hooks in sessions.ts MUST skip their
 * ended-session diff on a failed refresh or a transient IPC blip would evict
 * every cached background transcript. Existing callers ignore the return.
 */
export async function refreshSessions(): Promise<boolean> {
  try {
    const all = await invoke<Instance[]>("list_instances");
    const next = (all || []).filter(isLive);

    const unread = loadUnreadSet();
    const liveIds = new Set(next.map(s => s.session_id));

    // GC: prune unread entries for sessions no longer alive
    for (const id of [...unread]) {
      if (!liveIds.has(id)) unread.delete(id);
    }

    // GC: drop parked permission/question prompts for dead sessions (e.g. the
    // chat was closed before the user switched back to answer).
    for (const id of pendingPromptSessionIds()) {
      if (!liveIds.has(id)) clearPendingPrompt(id);
    }

    // Mark unread for sessions that just finished a busy turn (busy true->false)
    // and are not currently open/selected.
    for (const s of next) {
      const wasBusy = state.prevBusyMap.get(s.session_id);
      if (wasBusy === true && !s.busy && s.session_id !== state.selectedId) {
        unread.add(s.session_id);
      }
    }

    // Auto-flush held messages for the ACTIVE session whenever it's idle with
    // something staged (unless Claude stopped to ask, in which case the held
    // set waits for the answer). Checked on every refresh rather than only on
    // the busy->false edge: the busy flag (instances-changed) and the chat
    // message stream (which derives questionSessions from the cc-status
    // marker) are separate, independently-lossy channels, so a one-shot edge
    // check can race and permanently strand a held message. onCompletion() is
    // idempotent (no-ops once the held set is empty), so re-checking on every
    // tick — including right after switching back to a chat that finished
    // while it wasn't selected — is safe.
    const active = next.find(s => s.session_id === state.selectedId);
    if (active && !active.busy && state.heldMessages?.hasItemsForActive()) {
      const isQuestion = active.awaiting === "question";
      state.heldMessages.onCompletion(active.session_id, isQuestion);
    }

    // Auto-flush held messages for BACKGROUNDED idle sessions too: a message
    // queued in chat A must send the moment A's turn finishes, even while a
    // different chat stays on screen. Same question gate as the active path,
    // evaluated per session; send_message is a plain IPC call, so no pane
    // needs to be mounted. flushBackground clears the held set before the
    // async send, so it can't double-fire against the reselect flush in
    // active-session.ts (which no-ops on an empty set).
    for (const s of next) {
      if (s.session_id === state.selectedId || s.busy) continue;
      if (!state.heldMessages?.hasItemsFor(s.session_id)) continue;
      const isQuestion = s.awaiting === "question";
      if (isQuestion) continue;
      const sid = s.session_id;
      const cwd = s.cwd;
      void state.heldMessages.flushBackground(sid, (blocks) =>
        invoke<void>("send_message", { sessionId: sid, cwd, blocks }),
      );
    }

    // Update prevBusyMap for next call
    state.prevBusyMap = new Map(next.map(s => [s.session_id, s.busy]));

    saveUnreadSet(unread);
    state.sessions = next;
    updateFaviconBadge(next, unread);
    return true;
  } catch (err) {
    console.error("[sessions] list_instances failed", err);
    state.sessions = [];
    return false;
  }
}

export function renderSidebar(listEl: HTMLElement): void {
  sidebarListEl = listEl;
  setRerenderCallback(() => renderSidebar(listEl));

  // List-building (filter/sort/segment) lives in sidebar-entries.ts (ai_todo
  // 463); shared drain/scheduled state is threaded in rather than imported
  // there, to avoid a cycle back into this file.
  const entries = buildSidebarEntries(
    listEl,
    () => renderSidebar(listEl),
    drainMap,
    scheduledCountMap,
    scheduledPendingPlaceholders,
    refreshDrainMap,
    refreshScheduledCounts,
  );

  reconcileList(listEl, entries, loadAnimEnabled());
  // Delegated, so it survives every reconcile without rebinding per row.
  attachRowTooltips(listEl);
  // Resolve hero avatar images to data URLs (idempotent per character id).
  void hydrateCharacterAvatars(listEl);
  void hydrateProjectTechIcons(listEl);
}
