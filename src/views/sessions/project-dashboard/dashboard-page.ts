// The project dashboard as a page of its own in the chat pane, reached from a
// chat header's project name, Ctrl+Shift+D, the chat menu's Dashboard item or
// the Home screen's project rows. Its back button returns to the chat that was
// open before; opening any chat from the sidebar leaves it the same way.
// In-memory only: nothing about it has to survive a restart.
import { isPendingSessionId } from "../../../shared/chat/pending-session-id";
import { isRemote } from "../../../shared/transport";
import { dismountActivePane, selectSession } from "../active-session";
import { snapshotActiveCardDraft } from "../permission-modal/question-ui";
import { savePendingPromptDraft } from "../permission-modal/gating";
import { dismissQuestionCard } from "../permission-modal";
import { resumeDraft } from "../pending-flow";
import { paneEmptyStateHtml } from "../sessions-helpers";
import { renderSidebar } from "../sidebar";
import { updateThinkingBar } from "../session-thinking-bar";
import { state } from "../state";
import { mountDashboard, type DashboardHandle } from "./dashboard";
import { resolveTarget } from "./draft-dashboard";

let handle: DashboardHandle | null = null;
/** The chat (or draft) that had the pane when the page opened; back returns to it. */
let resumeId: string | null = null;
let openSeq = 0;

function panes(): { view: HTMLElement, pane: HTMLElement, listEl: HTMLElement | null } | null {
  const view = document.querySelector<HTMLElement>(".view-sessions");
  const pane = view?.querySelector<HTMLElement>("#session-pane");
  if (!view || !pane) return null;
  return { view, pane, listEl: view.querySelector<HTMLElement>("#sessions-list") };
}

/** `restore` false means a chat is already taking the pane, so select nothing here. */
export function leaveDashboardPage(restore: boolean): void {
  // The bump sits ahead of the early return so a chat picked while an open is
  // still awaiting its target cancels that open too.
  openSeq++;
  state.onChatActivated = null;
  if (!state.dashboardOpen) return;
  state.dashboardOpen = false;
  handle?.destroy();
  handle = null;
  const id = resumeId;
  resumeId = null;
  const p = panes();
  if (!restore || !p) return;
  const { view, pane, listEl } = p;
  if (id && state.pendingNewSession?.placeholderId === id && isPendingSessionId(id)) {
    void resumeDraft(pane).then(updateThinkingBar);
  } else if (id && state.sessions.some((s) => s.session_id === id)) {
    void selectSession(id, pane).then(updateThinkingBar);
  } else {
    pane.innerHTML = paneEmptyStateHtml(state.daemonConnected, state.daemonSetupStalled);
    if (listEl) renderSidebar(listEl);
    // The phone goes back to the list it came from rather than an empty pane.
    if (isRemote()) view.setAttribute("data-mobile-pane", "list");
  }
}

/** Shows the dashboard for the repo at `cwd` (its group's, when it has one). */
export async function openDashboardPage(cwd: string, projectId: string | null = null): Promise<void> {
  const p = panes();
  if (!p) return;
  const { view, pane } = p;
  const mine = ++openSeq;
  // Armed before the await: setActiveSession fires it for a chat picked while
  // the target is still resolving, which cancels this open via openSeq.
  state.onChatActivated = () => leaveDashboardPage(false);
  const ref = await resolveTarget(cwd, projectId);
  if (mine !== openSeq) return;

  if (!state.dashboardOpen) {
    const open = state.selectedId;
    resumeId = open;
    if (open) {
      // Same hand-off selectSession does when switching away: keep an unanswered
      // question's draft and take its card off the screen.
      const draft = snapshotActiveCardDraft(open);
      if (draft) savePendingPromptDraft(open, draft);
    }
    dismissQuestionCard();
    state.dashboardOpen = true;
    dismountActivePane({ rerenderSidebar: true });
  }

  handle?.destroy();
  pane.replaceChildren();
  handle = mountDashboard(ref, {
    mode: "page",
    pane,
    leave: () => leaveDashboardPage(false),
    back: () => leaveDashboardPage(true),
    deselect: () => leaveDashboardPage(true),
  });
  pane.append(handle.root, handle.chips);
  if (isRemote()) view.setAttribute("data-mobile-pane", "chat");
}
