// The dashboard's menus: the project menu (the page header's kebab) and the
// right-click menu, which puts the clicked item's own actions above the same
// project actions. On the phone (where right-click is a long-press) only the
// item actions that work away from the PC are offered.
import { invoke } from "../../../shared/ipc";
import { askConfirm } from "../../../shared/confirm";
import { showToast } from "../../../shared/toast";
import { isRemote } from "../../../shared/transport";
import { createMoreMenu } from "../more-menu-base";
import { closeChatWithConfirm } from "../close-chat";
import { state } from "../state";
import { OPEN_COMMANDS, pickRepo, type ActionHost } from "./dash-actions";
import { forgetTargets } from "./draft-dashboard";
import { openCardsModal, openEditReposModal } from "./dash-modals";
import { openCharacterModal, openFolderMappingModal, openProjectSettingsModal, openRenameModal } from "./project-config";
import type { CtxItem } from "./dash-parts";

export interface MenuItem { icon: string, label: string, run: () => void, danger?: boolean }
/** A null entry draws a divider between the item's actions and the project's. */
type Entry = MenuItem | null;

const menu = createMoreMenu<[Entry[]]>({
  build: (m, close, entries) => {
    for (const it of entries) {
      if (!it) {
        const hr = document.createElement("div");
        hr.className = "smore-sep";
        m.appendChild(hr);
        continue;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.className = `smore-item${it.danger ? " is-danger" : ""}`;
      b.innerHTML = `<i class="ph ph-${it.icon}"></i><span></span>`;
      b.querySelector("span")!.textContent = it.label;
      b.onclick = () => { close(); it.run(); };
      m.appendChild(b);
    }
  },
});

// The right-click menu anchors to an invisible point moved to the cursor. It
// is kept, not removed on close: a group's "which repo?" menu opens from it
// after the first menu has already closed.
let point: HTMLElement | null = null;

function pointAt(x: number, y: number): HTMLElement {
  if (!point?.isConnected) {
    point = document.createElement("div");
    point.className = "pd-ctx-point";
    document.body.appendChild(point);
  }
  point.style.left = `${x}px`;
  point.style.top = `${y}px`;
  return point;
}

async function deleteGroup(host: ActionHost): Promise<void> {
  const t = host.ctx().snap.target;
  const ok = await askConfirm(
    `Delete the group "${t.name}"? Its repos stay as normal projects; only this grouping and its cards go away.`,
    { confirmLabel: "Delete" },
  );
  if (!ok) return;
  try {
    await invoke<void>("dashboard_group_delete", { id: t.id });
    forgetTargets();
    host.deselect();
  } catch (err) {
    showToast(`Could not delete the group: ${String(err)}`);
  }
}

const OPEN_IN: Array<{ kind: keyof typeof OPEN_COMMANDS, icon: string, label: string }> = [
  { kind: "vscode", icon: "code", label: "Open in VS Code" },
  { kind: "terminal", icon: "terminal-window", label: "Open a terminal here" },
  { kind: "explorer", icon: "folder-open", label: "Show in Explorer" },
];

/** Runs `open` for the dashboard's repo, asking which one first on a group. */
function forRepo(host: ActionHost, anchor: HTMLElement, open: (cwd: string, name: string) => void): () => void {
  return () => {
    void pickRepo(host.ctx(), anchor).then((repo) => { if (repo) open(repo.cwd, repo.name); });
  };
}

/** Everything about the project itself. Empty on the phone: each one opens an
 *  app on the PC or edits this PC's project config. */
export function projectItems(host: ActionHost, anchor: HTMLElement): Entry[] {
  if (isRemote()) return [];
  const t = host.ctx().snap.target;
  const reload = (): void => host.reload();
  const items: Entry[] = [];
  if (t.kind === "project") {
    items.push({ icon: "pencil-simple", label: "Rename project...", run: forRepo(host, anchor, (cwd) => openRenameModal(cwd, reload)) });
  }
  items.push({ icon: "user-circle", label: "Character...", run: forRepo(host, anchor, (cwd) => openCharacterModal(cwd)) });
  // A single project shows its settings in the dashboard's own rail (dashboard.ts).
  // The two share element ids, so a popup beside the rail would break both; a group
  // has no rail, because its repos each have their own settings, and asks which.
  if (t.kind === "group") {
    items.push({ icon: "gear", label: "Project settings...", run: forRepo(host, anchor, (cwd) => openProjectSettingsModal(cwd)) });
  }
  items.push(
    { icon: "folder-simple-dashed", label: "Folder mapping...", run: forRepo(host, anchor, (cwd) => openFolderMappingModal(cwd, host)) },
    { icon: "squares-four", label: "Dashboard cards...", run: () => openCardsModal(host) },
  );
  if (t.kind === "group") {
    items.push(
      { icon: "pencil-simple", label: "Edit repos...", run: () => openEditReposModal(host) },
      { icon: "trash", label: "Delete group", danger: true, run: () => void deleteGroup(host) },
    );
  }
  items.push(...OPEN_IN.map((o): MenuItem => ({ icon: o.icon, label: o.label, run: () => host.ctx().act.openIn(anchor, o.kind) })));
  return items;
}

export function copy(text: string, what: string): void {
  void navigator.clipboard.writeText(text).then(
    () => showToast(`Copied the ${what}`),
    (err) => showToast(`Could not copy: ${String(err)}`),
  );
}

/** The right-clicked item's own actions, empty when the click was on nothing in particular. */
export function itemActions(host: ActionHost, item: CtxItem): MenuItem[] {
  const c = host.ctx();
  const remote = isRemote();
  switch (item.kind) {
    case "chat": {
      if (!item.live) return [{ icon: "clock-counter-clockwise", label: "Open in History", run: () => c.act.openHistory(item.sessionId) }];
      const live = state.sessions.some((s) => s.session_id === item.sessionId);
      const out: MenuItem[] = [{ icon: "chat-circle", label: "Open chat", run: () => c.act.openChat(item.sessionId) }];
      if (live) out.push({ icon: "x", label: "Close chat...", danger: true, run: () => void closeChatWithConfirm(item.sessionId).then(() => host.reload()) });
      return out;
    }
    case "todo": {
      const done = c.doneTodos.has(item.todo.id);
      return [{ icon: done ? "arrow-counter-clockwise" : "check", label: done ? "Mark not done" : "Mark done", run: () => c.act.toggleTodo(item.todo) }];
    }
    case "card": {
      const out: MenuItem[] = [{ icon: "arrows-clockwise", label: "Refresh card", run: () => c.act.refreshCard(item.id) }];
      if (!remote) {
        out.push({
          icon: "eye-slash", label: "Hide this card",
          run: () => void invoke<void>("dashboard_card_set_enabled", { id: item.id, enabled: false })
            .then(() => host.reload(), (err) => showToast(`Could not hide the card: ${String(err)}`)),
        });
      }
      return out;
    }
    case "commit":
      return [{ icon: "copy", label: "Copy commit hash", run: () => copy(item.sha, "commit hash") }];
    case "file": {
      const out: MenuItem[] = [];
      if (item.exists && !remote) {
        out.push({ icon: "file-text", label: "Open", run: () => c.act.openFile(item.path) });
        out.push({
          icon: "code",
          label: "Open in VS Code",
          run: () => void invoke<void>("open_in_editor", { path: item.path }).catch((err) => showToast(`Could not open the file: ${String(err)}`)),
        });
      }
      out.push({ icon: "copy", label: "Copy path", run: () => copy(item.path, "path") });
      return out;
    }
    case "plan": {
      const out: MenuItem[] = [];
      if (item.id) out.push({ icon: "hash", label: `Copy #${item.id}`, run: () => copy(`#${item.id}`, "todo id") });
      out.push({ icon: "copy", label: "Copy text", run: () => copy(item.text, "text") });
      return out;
    }
    case "server": {
      const url = `http://localhost:${item.port}`;
      return [
        { icon: "arrow-square-out", label: "Open in browser", run: () => c.act.openUrl(url) },
        { icon: "copy", label: "Copy URL", run: () => copy(url, "URL") },
      ];
    }
  }
}

/** The nearest row or card under the click that says what it is (dash-parts' pdCtx). */
function itemAt(target: EventTarget | null, root: Element): CtxItem | null {
  for (let el = target instanceof Element ? target : null; el && el !== root; el = el.parentElement) {
    const item = (el as Element & { pdCtx?: CtxItem }).pdCtx;
    if (item) return item;
  }
  return null;
}

export function openProjectMenu(anchor: HTMLElement, host: ActionHost): void {
  if (menu.element()) { menu.close(); return; }
  menu.open(anchor, projectItems(host, anchor));
}

export function openContextMenu(e: MouseEvent, host: ActionHost): void {
  // Text fields keep the webview's own copy/paste menu.
  if (e.target instanceof Element && e.target.closest("input, textarea, [contenteditable]")) return;
  const root = e.currentTarget as Element;
  const anchor = pointAt(e.clientX, e.clientY);
  const item = itemAt(e.target, root);
  const own = item ? itemActions(host, item) : [];
  // The phone has no project items, so there only an item's own actions swallow the click.
  if (own.length || !isRemote()) e.preventDefault();
  const project = projectItems(host, anchor);
  const entries: Entry[] = own.length && project.length ? [...own, null, ...project] : [...own, ...project];
  if (entries.length) menu.open(anchor, entries);
}
