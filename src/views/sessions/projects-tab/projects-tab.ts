// "Chats | Projects" tab strip at the top of the Chats window sidebar. The
// Projects tab swaps the chat list for a list of projects and groups, and the
// chat pane for that target's dashboard. Everything here is in-memory: nothing
// about the tab has to survive a restart.
import { html, nothing, render } from "lit-html";
import { invoke } from "../../../shared/ipc";
import { getTransport, isRemote, type Unlisten } from "../../../shared/transport";
import { debounce } from "../../../shared/debounce";
import { isPendingSessionId } from "../../../shared/chat/pending-session-id";
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
import { sameRef } from "./format";
import { openClosedProjectsPicker } from "./open-picker";
import { isOpen, renderProjectsList } from "./projects-list";
import { showToast } from "../../../shared/toast";
import type { DashboardTargetRef, ListRow } from "./types";

import "./projects-tab.css";

export type SidebarTab = "chats" | "projects";

export interface ProjectsTabHandle {
  /** Current tab, for tests and callers that must not assume the chats list is showing. */
  tab(): SidebarTab;
  setTab(tab: SidebarTab): void;
  selectTarget(ref: DashboardTargetRef): void;
  destroy(): void;
}

const LIST_EVENTS = ["instances-changed", "dashboard-changed"];
const LIST_DEBOUNCE_MS = 400;

/** Mounts the strip + list into the sidebar. Null on the phone, which has no Projects tab yet. */
export function mountProjectsTab(view: HTMLElement, pane: HTMLElement, listEl: HTMLElement): ProjectsTabHandle | null {
  if (isRemote()) return null;
  const found = view.querySelector<HTMLElement>(".sessions-sidebar");
  if (!found) return null;
  const aside: HTMLElement = found;

  let tab: SidebarTab = "chats";
  let target: DashboardTargetRef | null = null;
  let rows: ListRow[] = [];
  let handle: DashboardHandle | null = null;
  let resumeId: string | null = null;
  let listSeq = 0;
  let destroyed = false;
  const unlisteners: Unlisten[] = [];

  const tabsEl = document.createElement("div");
  tabsEl.className = "pd-tabs";
  const listUl = document.createElement("ul");
  listUl.id = "projects-list";
  listUl.className = "sessions-list";
  aside.prepend(tabsEl);
  aside.insertBefore(listUl, listEl.nextSibling);

  const drawTabs = (): void => {
    const btn = (id: SidebarTab, icon: string, label: string) => html`
      <button type="button" class="pd-tab ${tab === id ? "on" : ""}" data-pd-tab=${id} @click=${() => setTab(id)}>
        <i class="ph ph-${icon}"></i>${label}</button>`;
    render(html`${btn("chats", "chats-circle", "Chats")}${btn("projects", "folders", "Projects")}`, tabsEl);
  };

  const openRows = (): ListRow[] => rows.filter(isOpen);
  const refOf = (r: ListRow): DashboardTargetRef => ({ kind: r.target.kind, id: r.target.id });

  const drawList = (): void => renderProjectsList(listUl, rows, target, {
    pick: (ref) => selectTarget(ref),
    close: (ref) => { void closeTarget(ref); },
    add: () => openClosedProjectsPicker(rows.filter((r) => !isOpen(r)), (ref) => { void openTarget(ref); }),
  });

  const showPlaceholder = (): void => {
    pane.replaceChildren();
    const el = document.createElement("div");
    el.className = "pd-root";
    const message = openRows().length ? "Pick a project"
      : rows.length ? "No open projects. Use + to open one." : "No projects yet";
    render(html`<div class="pd-quiet pd-loading">${message}</div>`, el);
    pane.appendChild(el);
  };

  function showTarget(ref: DashboardTargetRef): void {
    handle?.destroy();
    target = ref;
    pane.replaceChildren();
    handle = mountDashboard(ref, {
      pane,
      flipToChats: () => leaveProjects(false),
      reloadList: () => { void loadList(); },
      deselect: () => { target = null; handle?.destroy(); handle = null; void loadList(); },
    });
    pane.appendChild(handle.root);
    drawList();
  }

  /** Keeps the shown dashboard if its row is still open, else moves to the first open row. */
  function reconcileSelection(): void {
    const stillThere = target && openRows().some((r) => sameRef(target, refOf(r)));
    if (!stillThere) {
      target = null;
      const first = openRows()[0];
      if (first) { showTarget(refOf(first)); return; }
      handle?.destroy();
      handle = null;
      showPlaceholder();
    }
    drawList();
  }

  async function closeTarget(ref: DashboardTargetRef): Promise<void> {
    try {
      await invoke<void>("dashboard_close_target", { target: ref });
    } catch (err) {
      showToast(`Could not close the project: ${String(err)}`);
      return;
    }
    const was = openRows().findIndex((r) => sameRef(ref, refOf(r)));
    const row = rows.find((r) => sameRef(ref, refOf(r)));
    if (row) row.open = false;
    // Closing the shown project hands the pane to its neighbour, the way closing a chat does.
    if (sameRef(target, ref)) {
      target = null;
      handle?.destroy();
      handle = null;
      const open = openRows();
      const next = open[Math.min(Math.max(was, 0), open.length - 1)];
      if (next) showTarget(refOf(next)); else showPlaceholder();
    }
    drawList();
    void loadList();
  }

  async function openTarget(ref: DashboardTargetRef): Promise<void> {
    try {
      await invoke<void>("dashboard_open_target", { target: ref });
    } catch (err) {
      showToast(`Could not open the project: ${String(err)}`);
      return;
    }
    const row = rows.find((r) => sameRef(ref, refOf(r)));
    if (row) row.open = true;
    showTarget(ref);
    void loadList();
  }

  async function loadList(): Promise<void> {
    const mine = ++listSeq;
    try {
      const next = await invoke<ListRow[]>("dashboard_list_targets");
      if (destroyed || mine !== listSeq || tab !== "projects") return;
      rows = next;
      reconcileSelection();
    } catch (err) {
      console.warn("[projects-tab] dashboard_list_targets failed", err);
    }
  }

  function enterProjects(): void {
    tab = "projects";
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
    state.onChatActivated = () => leaveProjects(false);
    state.onCloseProject = () => { if (target) void closeTarget(target); };
    dismountActivePane({ rerenderSidebar: false });
    aside.classList.add("is-projects-tab");
    drawTabs();
    if (target) showTarget(target); else showPlaceholder();
    drawList();
    void loadList();
  }

  /** `restore` false means a chat is already taking the pane, so select nothing here. */
  function leaveProjects(restore: boolean): void {
    if (tab !== "projects") return;
    tab = "chats";
    state.dashboardOpen = false;
    state.onCloseProject = null;
    handle?.destroy();
    handle = null;
    aside.classList.remove("is-projects-tab");
    drawTabs();
    const id = resumeId;
    resumeId = null;
    if (!restore) return;
    if (id && state.pendingNewSession?.placeholderId === id && isPendingSessionId(id)) {
      void resumeDraft(pane).then(updateThinkingBar);
    } else if (id && state.sessions.some((s) => s.session_id === id)) {
      void selectSession(id, pane).then(updateThinkingBar);
    } else {
      pane.innerHTML = paneEmptyStateHtml(state.daemonConnected, state.daemonSetupStalled);
      renderSidebar(listEl);
    }
  }

  function setTab(next: SidebarTab): void {
    if (next === tab) return;
    if (next === "projects") enterProjects(); else leaveProjects(true);
  }

  function selectTarget(ref: DashboardTargetRef): void {
    if (tab !== "projects") return;
    if (sameRef(target, ref) && handle) return;
    showTarget(ref);
  }

  const reloadListSoon = debounce(() => { if (!destroyed && tab === "projects") void loadList(); }, LIST_DEBOUNCE_MS);
  for (const name of LIST_EVENTS) {
    void getTransport().listen(name, () => reloadListSoon()).then((u) => {
      if (destroyed) u(); else unlisteners.push(u);
    });
  }

  drawTabs();

  return {
    tab: () => tab,
    setTab,
    selectTarget,
    destroy: () => {
      destroyed = true;
      reloadListSoon.cancel();
      for (const u of unlisteners.splice(0)) { try { u(); } catch { /* already gone */ } }
      handle?.destroy();
      handle = null;
      if (state.onChatActivated) state.onChatActivated = null;
      state.onCloseProject = null;
      state.dashboardOpen = false;
      tabsEl.remove();
      listUl.remove();
      aside.classList.remove("is-projects-tab");
      render(nothing, tabsEl);
    },
  };
}
