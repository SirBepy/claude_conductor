// What a click on the dashboard does. Anything that opens a chat first leaves
// the standalone page (host.leave; a draft has nothing to leave), then reuses
// the normal selectSession / launchNewSession paths, so none of that logic is
// duplicated.
import { invoke } from "../../../shared/ipc";
import { api } from "../../../shared/api";
import { showToast } from "../../../shared/toast";
import { showView } from "../../../shared/navigation";
import { openFileWindow } from "../../../shared/open-file";
import { createMoreMenu } from "../more-menu-base";
import { resolveNewChatConfig, accountPickNeeded } from "../new-chat-config";
import { selectSession } from "../active-session";
import { updateThinkingBar } from "../session-thinking-bar";
import { state } from "../state";
import type { DashActions, DashCtx } from "./dash-parts";
import { withCommand } from "./format";
import { openReportsModal, showImageOverlay } from "./dash-reports";
import { copy, openProjectMenu } from "./dash-menu";
import type { CardResult, DashTodo, RepoRef } from "./types";
import type { UsageRange } from "./dash-usage";

/** The slice of the controller the actions need. */
export interface ActionHost {
  ctx(): DashCtx;
  pane(): HTMLElement;
  /** Leave the standalone page because a chat is about to take the pane; selects nothing. No-op in a draft. */
  leave(): void;
  /** Leave the standalone page for the chat open before it. */
  back(): void;
  /** Mutate the context, then repaint. */
  patch(fn: (c: DashCtx) => void): void;
  /** Refetch the snapshot now (after a modal changed server-side state). */
  reload(): void;
  /** The shown target is gone (a deleted group): take the dashboard down. */
  deselect(): void;
  /** Fetch the token history the Usage card needs for this range. */
  loadUsage(range: UsageRange): void;
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
export async function pickRepo(c: DashCtx, anchor: HTMLElement): Promise<RepoRef | null> {
  const repos = c.snap.target.repos;
  if (repos.length === 1) return repos[0] ?? null;
  if (repos.length === 0) return null;
  return new Promise<RepoRef | null>((resolve) => {
    let done = false;
    settleRepo = (r) => { if (done) return; done = true; settleRepo = null; resolve(r); };
    repoMenu.open(anchor, repos);
  });
}

function fillComposer(command: string): void {
  const composer = state.composer;
  if (!composer) return;
  composer.setDraftText(withCommand(composer.getDraftText(), command), false);
}

export const OPEN_COMMANDS = { vscode: "open_in_vscode", terminal: "open_terminal_in_directory", explorer: "open_in_explorer" } as const;

export function makeActions(host: ActionHost): DashActions {
  const selectLive = async (sessionId: string): Promise<boolean> => {
    if (!state.sessions.some((s) => s.session_id === sessionId)) return false;
    host.leave();
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
    runCommand: (anchor, command) => {
      if (host.ctx().mode === "draft") { if (command) fillComposer(command); else state.composer?.focus(); return; }
      void (async () => {
        const repo = await pickRepo(host.ctx(), anchor);
        if (!repo) return;
        const project = { path: repo.cwd, name: repo.name };
        const config = await resolveNewChatConfig(project.path);
        host.leave();
        state.launchNewChatCallback?.(project, command ? { ...config, draftText: `${command} ` } : config);
      })();
    },
    runCardAction: (anchor, message) => {
      if (host.ctx().mode === "draft") { void state.composer?.sendText(message); return; }
      void (async () => {
        const repo = await pickRepo(host.ctx(), anchor);
        if (!repo) return;
        const project = { path: repo.cwd, name: repo.name };
        let config;
        let needsAccount;
        try {
          config = await resolveNewChatConfig(project.path);
          needsAccount = await accountPickNeeded(config, project.path);
        } catch (err) {
          showToast(`Could not start the chat: ${String(err)}`);
          return;
        }
        host.leave();
        // The message embeds third-party card text, so this chat never inherits
        // the project's auto-accept: an injected instruction must hit a prompt.
        // With no account resolved it waits in the message box instead of
        // auto-sending into the account gate.
        const launch = needsAccount ? { draftText: message } : { initialMessage: message };
        state.launchNewChatCallback?.(project, { ...config, autoAccept: false, ...launch });
      })();
    },
    back: () => host.back(),
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
    openFile: (path) => openFileWindow(path),
    openUrl: (url) => { void api.openExternal(url).catch((err) => showToast(`Could not open the link: ${String(err)}`)); },
    openAllHistory: () => showView("history"),
    copyText: (text, what) => copy(text, what),
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
    openMenu: (anchor) => openProjectMenu(anchor, host),
    setTab: (tab) => { host.patch((c) => { c.tab = tab; }); if (tab === "gallery") host.loadGallery(); },
    setPage: (key, page) => host.patch((c) => { c.pages.set(key, Math.max(0, page)); }),
    openReportsModal: () => openReportsModal(host),
    setUsageRange: (range) => {
      host.patch((c) => { c.usage.range = range; });
      host.loadUsage(range);
    },
    setTodoRange: (range) => host.patch((c) => { c.todoRange = range; }),
    openImage: (id) => {
      const c = host.ctx();
      const src = c.images.get(id);
      const title = c.history?.gallery.find((g) => g.id === id)?.title ?? "";
      if (src && src !== "failed") showImageOverlay(src, title);
    },
  };
}
