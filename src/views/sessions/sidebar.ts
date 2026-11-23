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
import { inPutAwayFamily, readPutAway } from "./put-away";
import { parkedDisplayIds, clearPendingPrompt } from "./permission-modal";
import { loadAnimEnabled, reconcileList } from "./sidebar-anim";
import { hydrateCharacterAvatars, hydrateProjectTechIcons } from "../../shared/projects";
import { setRerenderCallback } from "./sidebar-ctx-menu";
import { attachSidebarHoverCard } from "./sidebar-hover-card";
import { HEAD_RECONCILE, buildHeadEntries, headsUi, rememberQuiet, setHeadTags, waitingRecheckDelay } from "./chat-heads";
import { ACTIVE_QUESTION_EVENT } from "./permission-modal/question-state";
import { draftOwners, headTagsEqual, tagOf } from "./chat-heads-model";
import type { HeadTag } from "./chat-heads-model";
import { sessionEvents } from "../../shared/chat/event-store";
import { unreadAnswerCount, unreadAnswerCountFromEvents } from "../../shared/chat/dashboard/answers-model";
import { answersApi, cachedSide, emptySide, rememberSide } from "./chat-dashboard/answers-api";
import { markViewed, onViewedChange, refreshViewed, setViewedOpenCheck, startViewedHeartbeat, stopViewedHeartbeat, viewedAtOf } from "./chat-seen";
import { getTransport, isRemote, isTauri } from "../../shared/transport";
import type { MessageDraft } from "../../types/ipc.generated";
import { headDragInFlight } from "./chat-heads-drag";
import { ensureMachineIcons } from "./machine-icons";
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
    const [all, putAway] = await Promise.all([
      invoke<Instance[]>("list_instances", undefined, { background }),
      readPutAway(background),
    ]);
    const next = (all || []).filter(isLive);

    const unread = loadUnreadSet();
    // A put-away chat is not in the list but is not dead either: its unread marks and parked cards
    // wait for the reopen.
    const liveIds = new Set([...next, ...putAway].map(s => s.session_id));

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
    // A put-away chat keeps its staged messages until it is reopened: the daemon refuses every send to it
    // (`PUT_AWAY:`), and a background flush clears the set before that answer.
    if (active && !active.busy && !active.frozen && !inPutAwayFamily(active, next) && state.heldMessages?.hasItemsForActive()) {
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
      if (s.session_id === state.selectedId || s.busy || s.frozen || inPutAwayFamily(s, next)) continue;
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
    state.putAway = putAway;
    pruneLiveQuestionProgress([...next, ...putAway].map((s) => s.session_id));
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

// ── Head tags: unread answers and drafts to send ────────────────────────────
//
// Each head's top-right tag (chat-heads.ts `tagHtml`). The numbers come from data the sidebar does
// not own, so they are computed apart from the render: the open chat reads its renderer's rows
// (what its Answers card reads), a chat that is not on screen reads its cached transcript, and
// both read the same read marks (`cachedSide`) and count only what came after the chat's viewed mark
// (chat-seen.ts, kept by the daemon so a view on any device clears it on the others). A chat whose
// transcript this window never loaded has no number: nothing here fetches history for a head.
const HEAD_TAG_POLL_MS = 500;
/** A background chat's transcript lags its status flip, so it is read once more shortly after. */
const HEAD_TAG_SETTLE_MS = 2500;
const HEAD_TAG_RETRY_MS = 30_000;

let tagTimer: ReturnType<typeof setInterval> | undefined;
/** Chats whose number could be read last time; the poll runs only while there is one to watch. */
let tracked = 0;
let appliedTags: ReadonlyMap<string, HeadTag> = new Map();
let owners = new Set<string>();
/** Last count per chat and what it was computed from, so an idle poll reads nothing. */
const unreadMemo = new Map<string, { sig: string; n: number; settleAt: number; rows?: string }>();
const sideTried = new Map<string, number>();
let draftsTried = 0;
let draftsKey = "";
let draftsRetryAt = 0;
let draftsSeq = 0;
let draftsListening = false;
let draftsDebounce: ReturnType<typeof setTimeout> | undefined;
const DRAFTS_MIN_GAP_MS = 400;
const DRAFTS_POLL_MS = 10_000;

function readSig(sid: string): string {
  const side = cachedSide(sid);
  if (!side) return "-";
  // A re-read overwrites a mark's time under the same key, so the key count alone misses it.
  let readSum = 0;
  for (const t of Object.values(side.store.read)) readSum += t;
  // A reply landing in an Ask thread turns a read answer unread again without touching the marks.
  let replies = 0;
  let lastReply = 0;
  for (const t of side.threads ?? []) {
    const msgs = t.messages ?? [];
    replies += msgs.length;
    lastReply = Math.max(lastReply, Number(msgs[msgs.length - 1]?.ts ?? 0));
  }
  return `${replies}:${lastReply}:${Object.keys(side.store.read).length}:${readSum}:${Object.keys(side.store.threads).length}:${Object.values(side.store.threads).join(",")}`;
}

/** Loads a chat's read marks once (the Answers card keeps them per chat in the daemon). The
 *  phone's tunnel has no such call: `unreadOf` counts there from the chat's viewed mark alone. */
function ensureSide(sid: string): void {
  if (isRemote() || cachedSide(sid)) return;
  if (Date.now() - (sideTried.get(sid) ?? 0) < HEAD_TAG_RETRY_MS) return;
  sideTried.set(sid, Date.now());
  void answersApi().load(sid).then((side) => {
    rememberSide(sid, side);
    syncHeadTags(true);
  }).catch((err) => console.warn("[sidebar] answers_state for a head tag failed", err));
}

function unreadOf(s: Instance, now: number): number | undefined {
  const sid = s.session_id;
  // The phone has no Answers read marks (the card is desktop only): its count is every answer after
  // the chat's viewed mark.
  const side = cachedSide(sid) ?? (isRemote() ? emptySide() : undefined);
  if (!side) { ensureSide(sid); return undefined; }
  const viewedAt = viewedAtOf(sid);
  const memo = unreadMemo.get(sid);
  const renderer = state.renderer;
  // A renderer still loading its rows holds none yet: a cached transcript answers until they arrive,
  // so the tag does not fade out and pop back in on opening the chat.
  const loading = renderer?.messages.length === 0 && (sessionEvents.isLoaded(sid) || memo !== undefined);
  if (loading && renderer?.sessionId === sid && !sessionEvents.isLoaded(sid)) return memo?.n;
  if (renderer && renderer.sessionId === sid && !loading) {
    const last = renderer.messages[renderer.messages.length - 1];
    const rows = `${renderer.messages.length}|${last?.id ?? ""}|${String(last?.ts ?? "")}`;
    const sig = `v|${rows}|${viewedAt}|${readSig(sid)}`;
    if (memo?.sig === sig) return memo.n;
    // Joe has this chat on screen: a new row landing in it is seen as it lands. Only a changed row
    // marks: a changed viewed mark alone must not mark again, or each mark would draw the next.
    // A row that lands while the window is hidden is not seen; `noteViewedChat` marks it when the window shows again.
    if (memo?.rows !== rows && sid === windowIdOf(state.selectedId) && document.visibilityState !== "hidden") markViewed(sid, now);
    const n = unreadAnswerCount(renderer.messages, side, now, viewedAt);
    unreadMemo.set(sid, { sig, n, settleAt: 0, rows });
    return n;
  }
  // An evicted cache keeps the last count rather than blinking the tag out.
  if (!sessionEvents.isLoaded(sid)) return memo?.n;
  const sig = `b|${s.busy}|${s.awaiting ?? ""}|${String(s.progress?.state_since ?? "")}|${viewedAt}|${readSig(sid)}`;
  if (memo?.sig === sig && !(memo.settleAt > 0 && now >= memo.settleAt)) return memo.n;
  const n = unreadAnswerCountFromEvents(sessionEvents.events(sid), side, now, viewedAt);
  // One more read once the transcript has caught up with the status change.
  unreadMemo.set(sid, { sig, n, settleAt: memo?.sig === sig ? 0 : now + HEAD_TAG_SETTLE_MS, rows: memo?.rows });
  return n;
}

/** The chat on screen when the heads last looked: opening a chat marks it viewed and so does leaving
 *  it (what arrived while Joe was in it was seen). A sub open in its main chat's window marks both. */
let viewedOpen: string[] = [];
let viewedListening = false;
let viewedHidden = false;

function noteViewedChat(): void {
  if (!viewedListening) {
    viewedListening = true;
    // A mark that arrived from another device (or the daemon's own clock) redraws the heads.
    // The green number reads the marks at draw time and not through the tag data, so it draws even when no tag changed.
    onViewedChange(() => { if (sidebarListEl?.isConnected) { syncHeadTags(false); renderSidebar(sidebarListEl); } });
    // The poll may not run while the window is hidden, so the hiding itself is noted here.
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") viewedHidden = true; });
    setViewedOpenCheck((id) => id === state.selectedId || id === windowIdOf(state.selectedId));
  }
  const now = [state.selectedId, windowIdOf(state.selectedId)].filter((id, i, all): id is string => !!id && all.indexOf(id) === i && state.sessions.some((s) => s.session_id === id));
  const hidden = document.visibilityState === "hidden";
  // Leaving a chat marks nothing while the window is hidden or has only just shown again: Joe did not see what arrived meanwhile.
  if (!hidden && !viewedHidden) for (const id of viewedOpen) if (!now.includes(id)) markViewed(id, Date.now(), true);
  // The window showing again re-marks the chats on screen: a mark skipped while hidden is made now.
  for (const id of now) if (!hidden && (!viewedOpen.includes(id) || viewedHidden)) markViewed(id);
  viewedHidden = hidden;
  viewedOpen = now;
  if (now.length > 0) startViewedHeartbeat(() => viewedOpen);
  else stopViewedHeartbeat();
  // Other devices' marks, and ours from before this window opened: a few seconds apart at most.
  refreshViewed(state.sessions.map((s) => s.session_id));
}

/** Which chats hold a draft to send: one read of each project's drafts, the store being per project.
 *  Read again when the set of projects changes and when the store says a draft changed. */
function ensureDraftOwners(force = false): void {
  const byProject = new Map<string, string>();
  for (const s of state.sessions) if (!byProject.has(s.project_id || s.cwd)) byProject.set(s.project_id || s.cwd, s.session_id);
  const key = [...byProject.keys()].sort().join("|");
  // The desktop hears the store change; the phone's browser has no cheap event stream here, so it
  // reads again now and then.
  const reread = !isTauri() && Date.now() - draftsTried >= DRAFTS_POLL_MS;
  if (!force && key === draftsKey && !reread) return;
  if (!force && Date.now() - draftsTried < DRAFTS_MIN_GAP_MS) return;
  if (!force && Date.now() < draftsRetryAt) return;
  draftsKey = key;
  draftsTried = Date.now();
  const seq = ++draftsSeq;
  const failedProjects = new Set<string>();
  // One project that cannot be read (a stale session id) must not hide every other project's drafts.
  void Promise.all([...byProject.entries()].map(([project, sid]) =>
    invoke<{ drafts?: MessageDraft[] }>("list_message_drafts", { sessionId: sid }, { background: true })
      .then((v) => v?.drafts ?? [])
      .catch((err) => { failedProjects.add(project); console.warn("[sidebar] list_message_drafts for head tags failed", err); return [] as MessageDraft[]; }),
  )).then((lists) => {
    // A slower older read must not overwrite a newer one.
    if (seq !== draftsSeq) return;
    const read = draftOwners(lists.flat(), Date.now());
    // A project that could not be read keeps the pencils its chats had; every other project takes the fresh read.
    for (const s of state.sessions) if (failedProjects.has(s.project_id || s.cwd) && owners.has(s.session_id)) read.add(s.session_id);
    owners = read;
    if (failedProjects.size > 0) {
      // Tries again, but not on every poll tick while the daemon stays unreachable.
      draftsKey = "";
      draftsRetryAt = Date.now() + HEAD_TAG_RETRY_MS;
    }
    syncHeadTags(true);
  });
  if (isTauri() && !draftsListening) {
    draftsListening = true;
    // The panel, a copy or a revise changes the store; a burst of changes is one read.
    void getTransport().listen("message-drafts-changed", () => {
      clearTimeout(draftsDebounce);
      draftsDebounce = setTimeout(() => ensureDraftOwners(true), 150);
    }).catch(() => { draftsListening = false; });
  }
}

/** Recomputes every head's tag and, when one changed, hands them to the heads and (with `render`)
 *  draws again. Reads nothing that waits: the loads it starts land back here. */
function syncHeadTags(render: boolean): void {
  ensureDraftOwners();
  noteViewedChat();
  const now = Date.now();
  const next = new Map<string, HeadTag>();
  tracked = 0;
  for (const s of state.sessions) {
    if (isSubchat(s) && s.pinned_to_sidebar !== true) continue;
    const unread = unreadOf(s, now);
    if (unread !== undefined) tracked++;
    const tag = tagOf(unread, owners.has(s.session_id));
    if (tag) next.set(s.session_id, tag);
  }
  const changed = !headTagsEqual(appliedTags, next);
  appliedTags = next;
  setHeadTags(next);
  // The first read marks land after the first render: the poll starts as soon as there is a count to watch.
  startHeadTagPoll();
  if (changed && render && sidebarListEl) renderSidebar(sidebarListEl);
}

/** Reading an answer happens inside the open chat and sends the sidebar nothing, so the count is
 *  looked at again twice a second, but only while some chat has a number to look at. */
function startHeadTagPoll(): void {
  if (tagTimer !== undefined || tracked === 0) return;
  tagTimer = setInterval(() => {
    // The view went away, or nothing is counted any more: stop; renderSidebar starts it again.
    if (!sidebarListEl?.isConnected) tracked = 0;
    else syncHeadTags(true);
    if (tracked === 0) { clearInterval(tagTimer); tagTimer = undefined; }
  }, HEAD_TAG_POLL_MS);
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

let waitingTimer: ReturnType<typeof setTimeout> | undefined;
let cardListening = false;

/** A head's red count follows the card on screen: it draws again when a card mounts, collapses or
 *  goes (nothing else tells the sidebar), and once more when a count still holding the card of a
 *  chat that was just opened has to settle. */
function followCards(listEl: HTMLElement): void {
  if (!cardListening) {
    cardListening = true;
    window.addEventListener(ACTIVE_QUESTION_EVENT, () => { if (sidebarListEl?.isConnected) renderSidebar(sidebarListEl); });
    // A quiet card raised for the chat on screen never parks, so only its own payload says it is quiet.
    void getTransport().listen<{ id?: string; quiet?: boolean }>("question-requested", (payload) => {
      if (payload?.quiet !== true || !payload.id) return;
      rememberQuiet(payload.id);
      if (sidebarListEl?.isConnected) renderSidebar(sidebarListEl);
    }).catch(() => {});
  }
  clearTimeout(waitingTimer);
  const delay = waitingRecheckDelay();
  if (delay !== null) waitingTimer = setTimeout(() => { if (listEl.isConnected) renderSidebar(listEl); }, delay + 20);
}

export function renderSidebar(listEl: HTMLElement): void {
  sidebarListEl = listEl;
  setRerenderCallback(() => renderSidebar(listEl));
  // The drop renders once; see headDragInFlight.
  if (headDragInFlight()) return;

  // The tags are computed before the heads are built; a change found here is drawn by this render.
  syncHeadTags(false);
  const { entries } = buildHeadEntries(scheduledCountMap, scheduledPendingPlaceholders, refreshScheduledCounts);
  // Nothing re-sorts a head on its own, but a head still enters, leaves and slides into the gap
  // a closed chat leaves, and the stack opens and closes with a stagger.
  // Settings > Appearance > Sidebar animations still switches the motion off.
  reconcileList(listEl, entries, loadAnimEnabled(), HEAD_RECONCILE);
  listEl.classList.toggle("is-closed", !headsUi.open);
  listEl.classList.toggle("kbd-hint-active", headsUi.numbers);
  syncHintEntrance(listEl);
  followCards(listEl);
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
