import type { Instance, ProtocolState } from "../../types/ipc.generated";
import type { ChatRenderer } from "../../shared/chat/chat-renderer";
import type { Composer } from "../../shared/chat/composer";
import type { HeldMessages } from "../../shared/chat/held-messages";
import type { ScheduledChip } from "../../shared/chat/scheduled-chip";
import { setSelectedSessionId } from "./permission-modal";
import type { SessionStatusbar } from "./session-statusbar";
import type { SessionConfig } from "./model-effort-modal";
import type { ChangesPanel } from "./changes-panel";
import type { PreviewController } from "./preview-panel";

export interface ParkedDraft {
  placeholderId: string;
  projectPath: string;
  projectName: string;
  config: SessionConfig;
}

export interface PendingNewSession {
  placeholderId: string;
  projectPath: string;
  projectName: string;
  // Model + effort chosen via openModelEffortModal at launch. Stored so we
  // can re-render the pending pane on resume after the user navigates away.
  config: SessionConfig;
  // Once the real session_id is captured from the first SessionStarted event,
  // we record it here so refreshSessions/renderSidebar can suppress the real
  // entry from the registry list (the pending row, now upgraded, represents
  // it). Cleared when start_session resolves.
  realId: string | null;
  // False between `+ New chat` and the user actually sending the first
  // message. While false, sidebar shows a draft row (no spinner) and the
  // thinking bar stays hidden — no work is in flight yet.
  firstMessageSent: boolean;
  // Snapshot of session_ids that existed in `state.sessions` at the moment
  // this pending entry was created. Sidebar uses it to filter out only the
  // *newcomer* row whose cwd matches `projectPath` (i.e. our own claude -p
  // spawn registered as External by the SessionStart hook before our chat
  // IPC captures the real session_id). Pre-existing rows in the same cwd
  // stay visible.
  preExistingSessionIds: Set<string>;
  // Wall-clock ms when firstMessageSent flipped to true. Used at restore
  // time to auto-discard pending entries whose start_session RPC died with
  // the previous app instance (firstMessageSent && !realId && stale).
  firstMessageSentAt: number | null;
}

export interface SessionsState {
  mountId: number;
  sessions: Instance[];
  selectedId: string | null;
  filter: string;
  renderer: ChatRenderer | null;
  composer: Composer | null;
  /** Messages typed while Claude is busy (staged, bundled into one send).
   * Mirrored to localStorage and rehydrated on construction, so a reload
   * doesn't lose them. */
  heldMessages: HeldMessages | null;
  /** Per-chat scheduled-message chip for the active pane. Re-created on every
   * mount (unlike heldMessages, it holds no cross-session state worth
   * preserving); destroyed on unmount. In-memory only. */
  scheduledChip: ScheduledChip | null;
  unlistenInstances: (() => void) | null;
  /** Unsubscribe for the "scheduled-items-changed" event (sidebar's scheduled
   *  marker/count recount - see sidebar.ts's forceRefreshScheduledCounts). */
  unlistenScheduled: (() => void) | null;
  pendingNewSession: PendingNewSession | null;
  parkedDrafts: ParkedDraft[];
  statusbar: SessionStatusbar | null;
  changesPanel: ChangesPanel | null;
  prevBusyMap: Map<string, boolean>;
  sortedSessionIds: string[];
  /** Latest global sleep/shutdown-when-done protocol state, hydrated on mount
   * via get_when_done_state and kept fresh by the `when-done-state` event.
   * Null until first hydration. In-memory only (the daemon owns the truth). */
  whenDone: ProtocolState | null;
  /** Whether the daemon process is currently connected. Null = not yet known
   * (hydrated async on mount via is_daemon_connected IPC). */
  daemonConnected: boolean | null;
  /** True once the daemon has stayed unconnected past the stall threshold.
   * Swaps the sidebar's "Setting up..." spinner for a visible warning instead
   * of spinning forever (2026-06-12 incident: daemon crash-looped on a hostage
   * port and the UI gave no hint anything was wrong). Cleared on connect. */
  daemonSetupStalled: boolean;
  /** Set by sessions.ts on mount. Called by active-session when the pickup CTA launches a new chat. */
  launchNewChatCallback: ((project: { path: string; name: string }, config: SessionConfig) => void) | null;
  /** Seam for the active session's ChangesPanel.toggle(). Set by active-session.ts when a
   * pane mounts; cleared on unmount. Allows the view-more-menu and sidebar ctx-menu to
   * invoke "View changes" for the currently-selected session without importing active-session. */
  activeChatActions: { viewChanges: () => void } | null;
  /** Set by sessions.ts on mount, cleared on unmount. Lets setActiveSession
   *  (below) scope the docked preview panel to whichever chat is active,
   *  without active-session.ts importing preview-panel.ts directly. */
  previewController: PreviewController | null;
  /** Session ids currently mid-takeover (external -> interactive promotion).
   *  The takeover-btn handler owns reconciling its own pane in place; the
   *  global instances-changed listener (sessions-wiring.ts) skips ids in
   *  this set so the two don't race to both rebuild the pane. */
  takeoverInFlightIds: Set<string>;
}

export function createInitialState(mountId: number): SessionsState {
  return {
    mountId,
    sessions: [],
    selectedId: null,
    filter: "",
    renderer: null,
    composer: null,
    heldMessages: null,
    scheduledChip: null,
    unlistenInstances: null,
    unlistenScheduled: null,
    pendingNewSession: null,
    parkedDrafts: [],
    statusbar: null,
    changesPanel: null,
    prevBusyMap: new Map(),
    sortedSessionIds: [],
    whenDone: null,
    daemonConnected: null,
    daemonSetupStalled: false,
    launchNewChatCallback: null,
    activeChatActions: null,
    previewController: null,
    takeoverInFlightIds: new Set(),
  };
}

// Module-level singleton. mountId protects against stale-mount writes when
// the user rapid-fires view switches: every async callback reads the current
// state.mountId and bails if it no longer matches the captured id.
export let state: SessionsState = createInitialState(0);

let _nextMountId = 1;

/**
 * Allocate a fresh mountId and replace the module-level state singleton with
 * a clean record bound to that mountId. Returns the new mountId so callers
 * can capture it for stale-write checks (`if (state.mountId !== myMount)`).
 */
export function resetState(): number {
  const id = _nextMountId++;
  state = createInitialState(id);
  return id;
}

const LS_LAST_SELECTED = "cc_last_selected_session";

/**
 * Single point of truth for the active session id. Mutating
 * `state.selectedId` directly without notifying permission-modal would
 * silently gate-out modals for the new session. Always go through this
 * helper.
 *
 * Side-effect: persists the id to localStorage so the next mount can
 * restore the last-viewed chat after a reload / app restart. Pending
 * placeholder ids (prefix "pending-") are not persisted - they are tracked
 * via the separate pending-session storage in pending-flow.ts.
 *
 * Deselecting (`id === null`) does NOT erase the persisted id. A daemon
 * restart (dev rebuild, crash, app update) transiently empties the session
 * list, which fires `setActiveSession(null)` to clear the pane; if that also
 * wiped the persisted id, the restore-on-reconnect would find nothing and the
 * user would land on a blank app and have to hunt their chat down in History.
 * Persistence is cleared only by an explicit close via `clearLastSelectedSession`.
 * Restoring a genuinely-ended session is already prevented by the
 * `state.sessions.find(...)` guard at the restore sites in sessions.ts.
 */
export function setActiveSession(id: string | null): void {
  state.selectedId = id;
  setSelectedSessionId(id);
  state.previewController?.setSessionScope(id);
  if (id && !id.startsWith("pending-")) {
    try {
      localStorage.setItem(LS_LAST_SELECTED, id);
    } catch {
      /* quota or storage disabled */
    }
  }
}

export function loadLastSelectedSession(): string | null {
  try {
    return localStorage.getItem(LS_LAST_SELECTED);
  } catch {
    return null;
  }
}

/**
 * Forget the persisted last-viewed chat. Called only on an explicit close so a
 * deliberately-closed chat is not re-opened on the next mount. NOT called on a
 * transient deselect (see setActiveSession).
 */
export function clearLastSelectedSession(): void {
  try {
    localStorage.removeItem(LS_LAST_SELECTED);
  } catch {
    /* storage disabled */
  }
}
