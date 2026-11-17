import { invoke } from "../../shared/ipc";
import { updateFaviconBadge } from "../../shared/favicon-badge";
import type { Instance, ScheduledItem } from "../../types/ipc.generated";
import {
  loadUnreadSet,
  saveUnreadSet,
  scheduledCountsBySession,
  scheduledPendingPlaceholderIds,
  isSubchat,
} from "./sessions-helpers";
import { state, windowIdOf } from "./state";
import { parkedDisplayIds, clearPendingPrompt } from "./permission-modal";
import { reconcileList } from "./sidebar-anim";
import { hydrateCharacterAvatars, hydrateProjectTechIcons } from "../../shared/projects";
import { setRerenderCallback } from "./sidebar-ctx-menu";
import { attachSidebarHoverCard } from "./sidebar-hover-card";
import { buildHeadEntries, headsUi } from "./chat-heads";
import { headDragInFlight } from "./chat-heads-drag";
import { ensureMachineIcons } from "./machine-icons";
import { isRemote } from "../../shared/transport";
import { saveCachedInstances } from "./instances-cache";
import { pruneLiveQuestionProgress } from "./question-progress";
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
export async function refreshSessions(background = true): Promise<boolean> {
  try {
    // A refresh runs on every instances-changed frame and after chat actions:
    // nobody waits on it, so a slow one never raises the phone's "Waiting for
    // your PC" strip. Only the first load of the list passes `false`.
    const all = await invoke<Instance[]>("list_instances", undefined, { background });
    const next = (all || []).filter(isLive);

    const unread = loadUnreadSet();
    const liveIds = new Set(next.map(s => s.session_id));

    // GC: prune unread entries for sessions no longer alive
    for (const id of [...unread]) {
      if (!liveIds.has(id)) unread.delete(id);
    }

    // GC: drop parked permission/question prompts for dead sessions (e.g. the
    // chat was closed before the user switched back to answer).
    for (const id of parkedDisplayIds()) {
      if (!liveIds.has(id)) clearPendingPrompt(id);
    }

    // Mark unread for sessions that just finished a busy turn (busy true->false)
    // and are not currently open/selected. A hidden sub is never unread: it has
    // no row to badge, and its result reaches Joe as a card in the main chat.
    for (const s of next) {
      const wasBusy = state.prevBusyMap.get(s.session_id);
      if (wasBusy === true && !s.busy && s.session_id !== windowIdOf(state.selectedId) && !isSubchat(s)) {
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
    // `!frozen` matters for a "hold until unfrozen" set: frozen sessions are
    // never busy (the process is torn down), so without this gate the idle
    // check above would fire the moment items are staged instead of waiting
    // for an actual unfreeze.
    const active = next.find(s => s.session_id === state.selectedId);
    if (active && !active.busy && !active.frozen && state.heldMessages?.hasItemsForActive()) {
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
      if (s.session_id === state.selectedId || s.busy || s.frozen) continue;
      if (!state.heldMessages?.hasItemsFor(s.session_id)) continue;
      const isQuestion = s.awaiting === "question";
      if (isQuestion && !state.heldMessages.hasAuqAnswerFor(s.session_id)) continue;
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
    pruneLiveQuestionProgress(next.map((s) => s.session_id));
    if (isRemote()) saveCachedInstances(next);
    // The badge counts chats the user can open, so subs stay out of it.
    updateFaviconBadge(next.filter((s) => !isSubchat(s)), unread);
    return true;
  } catch (err) {
    console.error("[sessions] list_instances failed", err);
    // The phone keeps its last-known list through a tunnel blip instead of
    // blanking it; the next successful refresh replaces it.
    if (!isRemote()) state.sessions = [];
    return false;
  }
}

/** How long the numbers' entrance class stays on after Ctrl first goes down. */
const KBD_HINT_ENTER_MS = 300;
let hintWasOn = false;
let hintEnterTimer: ReturnType<typeof setTimeout> | undefined;

/** Plays the numbers' entrance only on the rising edge of the Ctrl hold. A jump mid-hold
 *  reorders the heads (the DOM nodes move), and a node that moves replays any animation it
 *  still carries, so the class drops after the entrance while kbd-hint-active stays. */
function syncHintEntrance(listEl: HTMLElement): void {
  const on = headsUi.numbers;
  if (on && !hintWasOn) {
    listEl.classList.add("kbd-hint-entering");
    clearTimeout(hintEnterTimer);
    hintEnterTimer = setTimeout(() => listEl.classList.remove("kbd-hint-entering"), KBD_HINT_ENTER_MS);
  } else if (!on) {
    clearTimeout(hintEnterTimer);
    listEl.classList.remove("kbd-hint-entering");
  }
  hintWasOn = on;
}

export function renderSidebar(listEl: HTMLElement): void {
  sidebarListEl = listEl;
  setRerenderCallback(() => renderSidebar(listEl));
  // The drop renders once; see headDragInFlight.
  if (headDragInFlight()) return;

  const { entries } = buildHeadEntries(scheduledCountMap, scheduledPendingPlaceholders, refreshScheduledCounts);
  // Heads never slide: they sit in a column Joe reads by position, and nothing re-sorts.
  reconcileList(listEl, entries, false);
  listEl.classList.toggle("is-closed", !headsUi.open);
  listEl.classList.toggle("kbd-hint-active", headsUi.numbers);
  syncHintEntrance(listEl);
  // Heads render the generic machine glyph until list_machines lands; this
  // re-renders once the per-machine icons are known.
  ensureMachineIcons(
    state.sessions.flatMap((s) => (s.machine ? [s.machine.id] : [])),
    () => renderSidebar(listEl),
  );
  // Delegated, so it survives every reconcile without rebinding per head.
  attachSidebarHoverCard(listEl);
  // Resolve hero avatar images to data URLs (idempotent per character id).
  void hydrateCharacterAvatars(listEl);
  void hydrateProjectTechIcons(listEl);
}
