// List-building half of sidebar.ts's renderSidebar (ai_todo 463): filter,
// sort, segment -> entries array. Reconcile/hydrate stays in sidebar.ts.
// Pure move, no behavior change.

import type { Instance } from "../../types/ipc.generated";
import {
  projectName,
  sessionSubtitle,
  sortSessions,
  sessionSegment,
  deriveQuestionSet,
  loadUnreadSet,
  loadSort,
  loadHiddenSessions,
  saveHiddenSessions,
  loadHiddenProjects,
  loadHiddenCollapsed,
  isSegCollapsed,
  resetSegCollapse,
  isJarvisOrWorker,
} from "./sessions-helpers";
import { renderProjectRail } from "./project-rail";
import { state } from "./state";
import { getChatSlotMode, getSlotAssignment } from "../../shared/shortcuts";
import { pendingPromptSessionIds } from "./permission-modal";
import { isBlocked } from "../../shared/chat/rate-limit-banner";
import { renderSidebarRow, sessionRowOptions, draftRowOptions, parkedRowOptions } from "./sidebar-rows";
import { loadRowStyle } from "./row-style";

/** Builds the sidebar's flat `entries` array (filter, sort, segment) for
 *  renderSidebar to reconcile into the DOM. Drain/scheduled state and the
 *  rerender callback are threaded in rather than imported, to avoid a
 *  cycle back into sidebar.ts. */
export function buildSidebarEntries(
  listEl: HTMLElement,
  rerender: () => void,
  drainMap: Map<string, number>,
  scheduledCountMap: Map<string, number>,
  scheduledPendingPlaceholders: Set<string>,
  refreshDrainMap: (sessionIds: string[]) => void,
  refreshScheduledCounts: () => void,
): Array<{ key: string; html: string }> {
  const filter = state.filter.toLowerCase();
  const pending = state.pendingNewSession;
  const unread = loadUnreadSet();
  // Jarvis (todo 272) and its worker sub-sessions are hidden from every row
  // here (segments, project rail, hidden section) - they live in Jarvis's
  // own window only. state.sessions itself stays the full unfiltered set;
  // only this list-building path filters.
  const listSessions = state.sessions.filter((s) => !isJarvisOrWorker(s));
  // The viewed chat's parked prompt is already shown as a card; don't also flag
  // its row with the attention alarm (backgrounded parked prompts still badge).
  const attention = pendingPromptSessionIds();
  if (state.selectedId) attention.delete(state.selectedId);
  // Registry-backed only (see deriveQuestionSet): one source of truth for the
  // question flag, covering background sessions too.
  const question = deriveQuestionSet(listSessions);
  // A permission-shaped prompt never sets awaiting="question", so excluding
  // it from `attention` above leaves the open chat with no "needs input"
  // signal and it wrongly falls into the busy check. Union the undeleted
  // pending-prompt set into `question` so it still outranks busy, no pulse.
  for (const id of pendingPromptSessionIds()) question.add(id);
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
  if (railHost) renderProjectRail(railHost, listSessions, rerender);

  const hiddenSessions = listSessions.filter(s => hidden.has(s.session_id) && !projectHidden(s));

  // Once the real session behind a draft is in state.sessions, let it render
  // through the normal segmented row instead of the static "starting..."
  // placeholder, which never reflects live status - that placeholder is what
  // forced a nav-away-and-back to see a just-sent draft's row catch up.
  const pendingRealId = pending?.realId ?? null;
  const pendingRealVisible = !!pendingRealId && listSessions.some(s => s.session_id === pendingRealId);

  let visible = listSessions.filter(s => !hidden.has(s.session_id) && !projectHidden(s));
  if (pendingRealId && !pendingRealVisible) {
    visible = visible.filter(s => s.session_id !== pendingRealId);
  } else if (pending && !pendingRealId) {
    // Pre-resolution window: the SessionStart hook on our own `claude -p`
    // spawn registers an External entry before chat IPC captures the real
    // session_id. Hide that newcomer row so it doesn't double-render the
    // pending placeholder. Pre-existing sessions in the same cwd stay visible.
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

  if ((pending && !pendingHidden && !pendingRealVisible) || visibleParked.length > 0) {
    entries.push({
      key: "__seg:draft__",
      html: `<li class="session-group-header" data-row-key="__seg:draft__">Draft</li>`,
    });
  }

  if (pending && !pendingHidden && !pendingRealVisible) {
    const isPendingActive = state.selectedId === pending.placeholderId;
    const html = renderSidebarRow(draftRowOptions(pending, isPendingActive, isPortrait, rowClass));
    entries.push({ key: `p:${pending.placeholderId}`, html });
  }

  for (const d of visibleParked) {
    entries.push({
      key: `p:${d.placeholderId}`,
      html: renderSidebarRow(parkedRowOptions(d, isPortrait, rowClass)),
    });
  }

  // Sessions with a pending/firing scheduled message, keyed off the same
  // count map the badge itself reads - a session shows in Scheduled iff it'd
  // also show the clock badge.
  const scheduledIds = new Set(scheduledCountMap.keys());

  const SEGMENT_LABELS = ["Input Needed", "Done", "In Progress", "Closing", "Waiting for Reset", "Waiting", "Scheduled", "Remote"];
  const segmented: Map<number, typeof sorted> = new Map([[0, []], [1, []], [2, []], [3, []], [4, []], [5, []], [6, []], [7, []]]);
  for (const s of sorted) {
    segmented.get(sessionSegment(s, unread, attention, question, closing, rateLimited, scheduledIds))!.push(s);
  }

  let sessionIndex = 0;
  // Same order as the data-kbd-hint badges below, so Ctrl+N always opens the
  // row visually numbered N (a flat pre-segmentation sort drifted from this).
  const kbdOrderIds: string[] = [];
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
        kbdOrderIds[i] = s.session_id;
        const isActive = s.session_id === state.selectedId;
        let kbdHint = "";
        if (isManualSlots) {
          const slot = slotBySession[s.session_id];
          if (slot) kbdHint = ` data-kbd-hint="${slot}"`;
        } else {
          if (i < 9) kbdHint = ` data-kbd-hint="${i + 1}"`;
        }
        entries.push({
          key: `s:${s.session_id}`,
          html: renderSidebarRow(sessionRowOptions(s, {
            isActive, unread, attention, question, rateLimited, closing, isPortrait, rowClass, sort, drainMap, scheduledCountMap, kbdHint,
          })),
        });
      }
    }
  };

  // "Waiting" (5) renders right after "In Progress" (2). "Closing" (3) alone
  // defers past Hidden below - see the renderSeg(3) call at the bottom.
  for (const seg of [0, 1, 2, 5, 4, 6, 7]) {
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
        entries.push({
          key: `s:${s.session_id}`,
          html: renderSidebarRow(sessionRowOptions(s, {
            isActive, unread, attention, question, rateLimited, closing, isPortrait, rowClass, sort, drainMap, scheduledCountMap, kbdHint: "",
          })),
        });
      }
    }
  }

  // Closing (transient, so it stays the true bottom).
  renderSeg(3);

  state.sortedSessionIds = kbdOrderIds;

  return entries;
}
