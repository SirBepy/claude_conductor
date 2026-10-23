// What a click on the dashboard does. Anything that opens a chat first hands
// the pane back to the chats tab (host.flipToChats), then reuses the normal
// selectSession / launchNewSession paths, so none of that logic is duplicated.
import { invoke } from "../../../shared/ipc";
import { api } from "../../../shared/api";
import { showToast } from "../../../shared/toast";
import { showView } from "../../../shared/navigation";
import { createMoreMenu } from "../more-menu-base";
import { openModelEffortModal } from "../model-effort-modal";
import { selectSession } from "../active-session";
import { updateThinkingBar } from "../session-thinking-bar";
import { state } from "../state";
import type { DashActions, DashCtx } from "./dash-parts";
import { openReportsModal, showImageOverlay } from "./dash-reports";
import { openDashKebab } from "./dash-kebab";
import type { CardResult, DashTodo, RepoRef } from "./types";

/** The slice of the controller the actions need. */
export interface ActionHost {
  ctx(): DashCtx;
  pane(): HTMLElement;
  /** Leave the dashboard because a chat is about to take the pane; selects nothing. */
  flipToChats(): void;
  /** Mutate the context, then repaint. */
  patch(fn: (c: DashCtx) => void): void;
  /** Refetch the snapshot and the projects list now (after a modal changed server-side state). */
  reload(): void;
  /** Drop the selected target (a deleted group) and show the empty dashboard pane. */
  deselect(): void;
  /** Start lazy gallery loading, one image at a time. */
  loadGallery(): void;
}

// One repo menu at a time; the pending promise settles on pick or dismiss.
let settleRepo: ((r: RepoRef | null) => void) | null = null;

const repoMenu = createMoreMenu<[RepoRef[]]>({
  beforeClose: () => { settleRepo?.(null); },
  build: (menu, close, repos) => {
    const label = document.createElement("span");
    label.className = "smore-section-label";
    label.textContent = "Which repo?";
    menu.appendChild(label);
    for (const r of repos) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "smore-item";
      b.innerHTML = `<i class="ph ph-git-branch"></i><span></span>`;
      b.querySelector("span")!.textContent = r.name;
      b.onclick = () => { settleRepo?.(r); close(); };
      menu.appendChild(b);
    }
  },
});

/** The repo an action applies to: the only repo, or the user's pick. */
async function pickRepo(c: DashCtx, anchor: HTMLElement): Promise<RepoRef | null> {
  const repos = c.snap.target.repos;
  if (repos.length === 1) return repos[0] ?? null;
  if (repos.length === 0) return null;
  return new Promise<RepoRef | null>((resolve) => {
    let done = false;
    settleRepo = (r) => { if (done) return; done = true; settleRepo = null; resolve(r); };
    repoMenu.open(anchor, repos);
  });
}

const OPEN_COMMANDS = { vscode: "open_in_vscode", terminal: "open_terminal_in_directory", explorer: "open_in_explorer" } as const;

export function makeActions(host: ActionHost): DashActions {
  const selectLive = async (sessionId: string): Promise<boolean> => {
    if (!state.sessions.some((s) => s.session_id === sessionId)) return false;
    host.flipToChats();
    await selectSession(sessionId, host.pane());
    updateThinkingBar();
    return true;
  };

  const openHistory = async (sessionId: string): Promise<void> => {
    // Dynamic: history.ts imports this view, so a static import would be a cycle.
    const { queueHistorySelect } = await import("../../history/history");
    queueHistorySelect(sessionId);
    showView("history");
  };

  return {
    newChat: (anchor, initialMessage) => {
      void (async () => {
        const repo = await pickRepo(host.ctx(), anchor);
        if (!repo) return;
        const project = { path: repo.cwd, name: repo.name };
        const config = await openModelEffortModal(project.path, project.name);
        if (!config) return;
        state.launchNewChatCallback?.(project, initialMessage ? { ...config, initialMessage } : config);
      })();
    },
    openIn: (anchor, kind) => {
      void (async () => {
        const repo = await pickRepo(host.ctx(), anchor);
        if (!repo) return;
        try { await invoke<void>(OPEN_COMMANDS[kind], { path: repo.cwd }); }
        catch (err) { showToast(`Could not open ${repo.name}: ${String(err)}`); }
      })();
    },
    openChat: (sessionId) => {
      void (async () => {
        if (await selectLive(sessionId)) return;
        await openHistory(sessionId);
      })();
    },
    openHistory: (sessionId) => { void openHistory(sessionId); },
    openFile: (path) => {
      void invoke<void>("open_in_vscode", { path }).catch((err) => showToast(`Could not open the file: ${String(err)}`));
    },
    openUrl: (url) => { void api.openExternal(url).catch((err) => showToast(`Could not open the link: ${String(err)}`)); },
    openAllHistory: () => showView("history"),
    toggleTodo: (todo: DashTodo) => {
      const wasDone = host.ctx().doneTodos.has(todo.id);
      host.patch((c) => { if (wasDone) c.doneTodos.delete(todo.id); else c.doneTodos.add(todo.id); });
      void invoke<void>("dashboard_todo_set_state", { projectId: todo.project_id, id: todo.id, next: wasDone ? "open" : "done" })
        .catch((err) => {
          host.patch((c) => { if (wasDone) c.doneTodos.add(todo.id); else c.doneTodos.delete(todo.id); });
          showToast(`Could not update the todo: ${String(err)}`);
        });
    },
    refreshCard: (id) => {
      host.patch((c) => { c.refreshing.add(id); });
      void invoke<CardResult>("dashboard_card_refresh", { id })
        .then((result) => host.patch((c) => {
          const v = c.snap.cards.find((x) => x.config.id === id);
          if (v) v.result = result;
        }))
        .catch((err) => showToast(`Could not refresh the card: ${String(err)}`))
        .finally(() => host.patch((c) => { c.refreshing.delete(id); }));
    },
    openKebab: (anchor) => openDashKebab(anchor, host),
    setTab: (tab) => { host.patch((c) => { c.tab = tab; }); if (tab === "gallery") host.loadGallery(); },
    setPage: (key, page) => host.patch((c) => { c.pages.set(key, Math.max(0, page)); }),
    openReportsModal: () => openReportsModal(host),
    openImage: (id) => {
      const c = host.ctx();
      const src = c.images.get(id);
      const title = c.history?.gallery.find((g) => g.id === id)?.title ?? "";
      if (src && src !== "failed") showImageOverlay(src, title);
    },
  };
}
