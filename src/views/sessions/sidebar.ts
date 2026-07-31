import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { updateFaviconBadge } from "../../shared/favicon-badge";
import type { Instance, DrainBoard, ScheduledItem } from "../../types/ipc.generated";
import {
  projectName,
  sessionSubtitle,
  statusIndicator,
  sortSessions,
  sessionSegment,
  deriveQuestionSet,
  loadUnreadSet,
  saveUnreadSet,
  loadSort,
  loadStateStyle,
  loadHiddenSessions,
  saveHiddenSessions,
  loadHiddenProjects,
  loadHiddenCollapsed,
  isSegCollapsed,
  resetSegCollapse,
  scheduledCountsBySession,
  scheduledPendingPlaceholderIds,
  isJarvisOrWorker,
} from "./sessions-helpers";
import { renderProjectRail } from "./project-rail";
import { state } from "./state";
import { getChatSlotMode, getSlotAssignment } from "../../shared/shortcuts";
import { pendingPromptSessionIds, clearPendingPrompt } from "./permission-modal";
import { reconcileList, loadAnimEnabled } from "./sidebar-anim";
import { hydrateCharacterAvatars, hydrateProjectTechIcons } from "../../shared/projects";
import { isBlocked } from "../../shared/chat/rate-limit-banner";
import { setRerenderCallback } from "./sidebar-ctx-menu";
import {
  drainChipHtml,
  leadingVisual,
  draftLeadingVisual,
  scheduledBadgeHtml,
  scheduledCornerHtml,
  modelBatteryHtml,
} from "./sidebar-row-visuals";
import { loadRowStyle } from "./row-style";
import { attachRowTooltips } from "../../shared/row-tooltip";
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

  const filter = state.filter.toLowerCase();
  const pending = state.pendingNewSession;
  const unread = loadUnreadSet();
  // Jarvis (todo 272) and its worker sub-sessions are hidden from every row
  // this function renders (segments, project rail, hidden section) - they
  // live in Jarvis's own dedicated window only. `state.sessions` itself stays
  // the full unfiltered live set (see isJarvisOrWorker's doc): only this
  // list-building path filters.
  const listSessions = state.sessions.filter((s) => !isJarvisOrWorker(s));
  // The viewed chat's parked prompt is already shown as a card; don't also flag
  // its row with the attention alarm (backgrounded parked prompts still badge).
  const attention = pendingPromptSessionIds();
  if (state.selectedId) attention.delete(state.selectedId);
  // Registry-backed only (see deriveQuestionSet): one source of truth for the
  // question flag, covering background sessions too.
  const question = deriveQuestionSet(listSessions);
  const style = loadStateStyle();
  const isPortrait = loadRowStyle() === "portrait";
  const rowClass = isPortrait ? "row-portrait" : "";
  const sort = loadSort();
  const rateLimited = new Set(listSessions.filter(isBlocked).map((s) => s.session_id));

  // Load hidden set and prune stale IDs. Only prune against a non-empty live
  // list: renderSidebar fires once on mount before refreshSessions()
  // resolves (state.sessions still []), and pruning against that transient
  // empty set would wipe every hidden id before the real list ever loads.
  const hidden = loadHiddenSessions();
  const liveIds = new Set(listSessions.map(s => s.session_id));
  if (listSessions.length > 0) {
    let hiddenPruned = false;
    for (const id of [...hidden]) {
      if (!liveIds.has(id)) { hidden.delete(id); hiddenPruned = true; }
    }
    if (hiddenPruned) saveHiddenSessions(hidden);
  }

  // Project-rail filter: hides a project's chats everywhere, including out of
  // the "Hidden" section below - a hidden project means nothing from it shows.
  const hiddenProjects = loadHiddenProjects();
  const projectHidden = (s: Instance): boolean => hiddenProjects.has(String(s.cwd ?? ""));
  const railHost = listEl.parentElement?.querySelector<HTMLElement>("#project-rail");
  if (railHost) renderProjectRail(railHost, listSessions, () => renderSidebar(listEl));

  const hiddenSessions = listSessions.filter(s => hidden.has(s.session_id) && !projectHidden(s));

  let visible = listSessions.filter(s => !hidden.has(s.session_id) && !projectHidden(s));
  if (pending?.realId) {
    visible = visible.filter(s => s.session_id !== pending.realId);
  } else if (pending) {
    // Pre-resolution window: the SessionStart hook on our own `claude -p`
    // spawn registers an External entry before chat IPC captures the real
    // session_id. Hide that newcomer row so it doesn't double-render
    // alongside the pending placeholder. Pre-existing sessions in the same
    // cwd stay visible.
    visible = visible.filter(s =>
      !(String(s.cwd) === pending.projectPath && !pending.preExistingSessionIds.has(s.session_id))
    );
  }

  const filtered = visible.filter(s =>
    !filter ||
    projectName(s).toLowerCase().includes(filter) ||
    sessionSubtitle(s).toLowerCase().includes(filter)
  );

  // Rendered purely off the daemon-broadcast Instance.closing flag: the
  // daemon sets it itself the moment a /close turn starts, so every window
  // shows the Closing segment.
  const closing = new Set(listSessions.filter((s) => s.closing).map((s) => s.session_id));
  // Only fetch token-drain data when the user is actually sorting by it. Fire
  // the (debounced) async refresh in the background; render now with whatever
  // drainMap already holds so render never blocks on the IPC.
  if (sort === "drain") {
    refreshDrainMap(filtered.map(s => s.session_id));
  }
  // Unconditional (unlike the drain fetch above): the scheduled marker/count
  // applies regardless of sort mode.
  refreshScheduledCounts();
  const sorted = sortSessions(filtered, sort, closing, drainMap);
  state.sortedSessionIds = sorted.map(s => s.session_id);

  const isManualSlots = getChatSlotMode() === "manual";
  const slotBySession: Record<string, number> = {};
  if (isManualSlots) {
    for (let slot = 1; slot <= 9; slot++) {
      const sid = getSlotAssignment(slot);
      if (sid) slotBySession[sid] = slot;
    }
  }

  const entries: Array<{ key: string; html: string }> = [];

  // Hide a draft row whose placeholder has a pending scheduled NewChat: the
  // user deferred it, so don't clutter the list with it until it fires (322 #6).
  const pendingHidden = !!pending && scheduledPendingPlaceholders.has(pending.placeholderId);
  const visibleParked = state.parkedDrafts.filter((d) => !scheduledPendingPlaceholders.has(d.placeholderId));

  if ((pending && !pendingHidden) || visibleParked.length > 0) {
    entries.push({
      key: "__seg:draft__",
      html: `<li class="session-group-header" data-row-key="__seg:draft__">Draft</li>`,
    });
  }

  if (pending && !pendingHidden) {
    const isPendingActive = state.selectedId === pending.placeholderId;
    const activeCls = isPendingActive ? "active" : "";
    // Key by placeholderId, NOT a constant "pending": consecutive drafts must
    // have distinct keys. A constant key let a just-discarded draft's exit
    // suppression (exitingKeys) leak onto the next draft, so the new draft was
    // filtered out and never rendered until its key changed (i.e. a message
    // turned it into a real session). The li carries data-placeholder-id so
    // keyOf() in sidebar-anim derives the matching `p:<id>` key.
    const pid = escapeHtml(pending.placeholderId);
    const html = !pending.firstMessageSent
      ? `<li class="${activeCls} pending draft" data-pending="1" data-placeholder-id="${pid}" title="Draft — type a message to start">
          ${draftLeadingVisual(pending.config.characterId, pending.projectPath)}
          <div class="session-row-text">
            <span class="session-row-project">Draft New Chat</span>
            <span class="session-row-subtitle">${escapeHtml(pending.projectName || "New session")}</span>
          </div>
          <button class="session-row-menu-btn icon-btn" title="Draft options" data-draft-menu="1">
            <i class="ph ph-dots-three-vertical"></i>
          </button>
        </li>`
      : `<li class="${activeCls} pending" data-pending="1" data-placeholder-id="${pid}" title="Starting new session... click X to discard if stuck">
          ${draftLeadingVisual(pending.config.characterId, pending.projectPath)}
          <div class="session-row-text">
            <span class="session-row-project">starting...</span>
            <span class="session-row-subtitle">${escapeHtml(pending.projectName || "New session")}</span>
          </div>
          <button class="session-row-menu-btn icon-btn" title="Draft options" data-draft-menu="1">
            <i class="ph ph-dots-three-vertical"></i>
          </button>
        </li>`;
    entries.push({ key: `p:${pending.placeholderId}`, html });
  }

  for (const d of visibleParked) {
    entries.push({
      key: `p:${d.placeholderId}`,
      html: `<li class="parked-draft" data-placeholder-id="${escapeHtml(d.placeholderId)}" title="Parked draft — click to resume">
        ${draftLeadingVisual(d.config.characterId, d.projectPath)}
        <div class="session-row-text">
          <span class="session-row-project">Draft New Chat</span>
          <span class="session-row-subtitle">${escapeHtml(d.projectName || "New session")}</span>
        </div>
        <button class="session-row-menu-btn icon-btn" title="Draft options" data-parked-placeholder-id="${escapeHtml(d.placeholderId)}">
          <i class="ph ph-dots-three-vertical"></i>
        </button>
      </li>`,
    });
  }

  const SEGMENT_LABELS = ["Input Needed", "Done", "In Progress", "Closing", "Waiting for Reset", "Waiting"];
  const segmented: Map<number, typeof sorted> = new Map([[0, []], [1, []], [2, []], [3, []], [4, []], [5, []]]);
  for (const s of sorted) {
    segmented.get(sessionSegment(s, unread, attention, question, closing, rateLimited))!.push(s);
  }

  let sessionIndex = 0;
  const renderSeg = (seg: number) => {
    const group = segmented.get(seg)!;
    if (group.length === 0) {
      resetSegCollapse(seg);
      return;
    }
    const segCollapsed = isSegCollapsed(seg);
    const chevronCls = segCollapsed ? "ph-caret-right" : "ph-caret-down";
    entries.push({
      key: `__seg:${seg}__`,
      html: `<li class="session-group-header session-group-seg-toggle" data-seg-toggle="${seg}" data-row-key="__seg:${seg}__">
        <i class="ph ${chevronCls}" style="margin-right:4px;font-size:10px;vertical-align:middle"></i>${SEGMENT_LABELS[seg]}
      </li>`,
    });
    if (!segCollapsed) {
      for (const s of group) {
        const i = sessionIndex++;
        const isActive = s.session_id === state.selectedId;
        const needsAttention = attention.has(s.session_id);
        const isClosing = closing.has(s.session_id);
        const indicator = statusIndicator(s, unread, attention, question, style, escapeHtml, rateLimited);
        let kbdHint = "";
        if (isManualSlots) {
          const slot = slotBySession[s.session_id];
          if (slot) kbdHint = ` data-kbd-hint="${slot}"`;
        } else {
          if (i < 9) kbdHint = ` data-kbd-hint="${i + 1}"`;
        }
        entries.push({
          key: `s:${s.session_id}`,
          html: `<li data-session-id="${escapeHtml(s.session_id)}"${kbdHint} class="${isActive ? "active" : ""} ${s.kind === "external" ? "is-external" : ""} ${needsAttention ? "needs-attention" : ""} ${isClosing ? "closing" : ""} ${rateLimited.has(s.session_id) ? "is-rate-limited" : ""} ${rowClass}">
            ${isPortrait
              ? leadingVisual(s, indicator, unread, attention, question, rateLimited, {
                  badgeClass: "is-centred",
                  extra: scheduledCornerHtml(scheduledCountMap.get(s.session_id)),
                })
              : leadingVisual(s, indicator, unread, attention, question, rateLimited)}
            <div class="session-row-text">
              ${isPortrait
                ? `<span class="session-row-project" data-tip="${escapeHtml(sessionSubtitle(s))}"><span class="proj-name">${escapeHtml(projectName(s))}</span>${s.is_remote ? `<i class="ph ph-device-mobile session-remote-badge" data-tip="Remote chat"></i>` : ""}${s.autopilot ? `<span class="autopilot-badge" data-tip="Autopilot active">autopilot</span>` : ""}</span>
              <span class="session-chips">${modelBatteryHtml(s.model)}${sort === "drain" ? drainChipHtml(drainMap.get(s.session_id)) : ""}</span>`
                : `<span class="session-row-project">${scheduledBadgeHtml(scheduledCountMap.get(s.session_id))}${escapeHtml(sessionSubtitle(s))}${s.is_remote ? `<i class="ph ph-device-mobile session-remote-badge" title="Remote chat"></i>` : ""}${s.autopilot ? `<span class="autopilot-badge" title="Autopilot active">autopilot</span>` : ""}</span>
              <span class="session-row-subtitle">${escapeHtml(projectName(s))}${sort === "drain" ? drainChipHtml(drainMap.get(s.session_id)) : ""}</span>`}
            </div>
            ${isPortrait ? "" : `<button class="session-row-menu-btn icon-btn" title="More options" data-session-id="${escapeHtml(s.session_id)}">
              <i class="ph ph-dots-three-vertical"></i>
            </button>`}
          </li>`,
        });
      }
    }
  };

  // "Waiting" (5, parked on an external process) renders right after
  // "In Progress" (2) so the blocked-on-a-script chats sit next to the
  // actively-running ones without disturbing the other groups' order.
  // "Closing" (3) is deferred past Hidden below - it renders dead last so a
  // chat mid-close never sits above the Hidden group and the disappearing
  // section is always the true bottom of the list.
  for (const seg of [0, 1, 2, 5, 4]) {
    renderSeg(seg);
  }

  if (entries.length === 0 && segmented.get(3)!.length === 0 && state.daemonConnected === true) {
    // While the daemon is NOT connected the pane shows the centered
    // "Setting up..." / stalled state (paneEmptyStateHtml); the sidebar
    // stays blank rather than duplicating it in a cramped row.
    entries.push({
      key: "__empty__",
      html: `<li class="sessions-empty-row" data-row-key="__empty__"><i class="ph ph-chat-circle-dots"></i>No active sessions</li>`,
    });
  }

  // Hidden section - always at the bottom
  if (hiddenSessions.length > 0) {
    const hiddenCollapsed = loadHiddenCollapsed();
    const chevronCls = hiddenCollapsed ? "ph-caret-right" : "ph-caret-down";
    entries.push({
      key: "__seg:hidden__",
      html: `<li class="session-group-header session-group-hidden-toggle" data-hidden-toggle="1" data-row-key="__seg:hidden__">
        <i class="ph ${chevronCls}" style="margin-right:4px;font-size:10px;vertical-align:middle"></i>Hidden (${hiddenSessions.length})
      </li>`,
    });
    if (!hiddenCollapsed) {
      for (const s of hiddenSessions) {
        const isActive = s.session_id === state.selectedId;
        const indicator = statusIndicator(s, unread, attention, question, style, escapeHtml, rateLimited);
        entries.push({
          key: `s:${s.session_id}`,
          html: `<li data-session-id="${escapeHtml(s.session_id)}" class="${isActive ? "active" : ""} ${s.kind === "external" ? "is-external" : ""} ${rowClass}">
            ${isPortrait
              ? leadingVisual(s, indicator, unread, attention, question, rateLimited, { badgeClass: "is-centred" })
              : leadingVisual(s, indicator, unread, attention, question, rateLimited)}
            <div class="session-row-text">
              ${isPortrait
                ? `<span class="session-row-project" data-tip="${escapeHtml(sessionSubtitle(s))}"><span class="proj-name">${escapeHtml(projectName(s))}</span></span>
              <span class="session-chips">${modelBatteryHtml(s.model)}</span>`
                : `<span class="session-row-project">${escapeHtml(sessionSubtitle(s))}</span>
              <span class="session-row-subtitle">${escapeHtml(projectName(s))}</span>`}
            </div>
            ${isPortrait ? "" : `<button class="session-row-menu-btn icon-btn" title="More options" data-session-id="${escapeHtml(s.session_id)}">
              <i class="ph ph-dots-three-vertical"></i>
            </button>`}
          </li>`,
        });
      }
    }
  }

  // Closing renders last, below Hidden - it's a transient, self-clearing
  // section, so it should never sit above a section that outlives it.
  renderSeg(3);

  reconcileList(listEl, entries, loadAnimEnabled());
  // Delegated, so it survives every reconcile without rebinding per row.
  attachRowTooltips(listEl);
  // Resolve hero avatar images to data URLs (idempotent per character id).
  void hydrateCharacterAvatars(listEl);
  void hydrateProjectTechIcons(listEl);
}

