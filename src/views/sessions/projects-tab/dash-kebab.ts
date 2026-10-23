// The dashboard header's kebab menu.
import { invoke } from "../../../shared/ipc";
import { askConfirm } from "../../../shared/confirm";
import { showToast } from "../../../shared/toast";
import { createMoreMenu } from "../more-menu-base";
import type { ActionHost } from "./dash-actions";
import { openCardsModal, openEditReposModal } from "./dash-modals";

interface Item { icon: string, label: string, run: () => void, danger?: boolean }

const menu = createMoreMenu<[Item[]]>({
  build: (m, close, items) => {
    for (const it of items) {
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

async function deleteGroup(host: ActionHost): Promise<void> {
  const t = host.ctx().snap.target;
  const ok = await askConfirm(
    `Delete the group "${t.name}"? Its repos stay as normal projects; only this grouping and its cards go away.`,
    { confirmLabel: "Delete" },
  );
  if (!ok) return;
  try {
    await invoke<void>("dashboard_group_delete", { id: t.id });
    host.deselect();
  } catch (err) {
    showToast(`Could not delete the group: ${String(err)}`);
  }
}

const OPEN_IN: Array<{ kind: "vscode" | "terminal" | "explorer", icon: string, label: string }> = [
  { kind: "vscode", icon: "code", label: "Open in VS Code" },
  { kind: "terminal", icon: "terminal-window", label: "Open a terminal here" },
  { kind: "explorer", icon: "folder-open", label: "Show in Explorer" },
];

export function openDashKebab(anchor: HTMLElement, host: ActionHost): void {
  const t = host.ctx().snap.target;
  const items: Item[] = [
    ...OPEN_IN.map((o): Item => ({ icon: o.icon, label: o.label, run: () => host.ctx().act.openIn(anchor, o.kind) })),
    { icon: "squares-four", label: "Dashboard cards...", run: () => openCardsModal(host) },
  ];
  if (t.kind === "group") {
    items.push(
      { icon: "pencil-simple", label: "Edit repos...", run: () => openEditReposModal(host) },
      { icon: "trash", label: "Delete group", danger: true, run: () => void deleteGroup(host) },
    );
  } else {
    const cwd = t.repos[0]?.cwd;
    if (cwd) {
      items.push({
        icon: "arrow-square-out", label: "Open project page",
        run: () => { void invoke<void>("open_dashboard_project", { cwd }).catch((e) => showToast(`Could not open the project page: ${String(e)}`)); },
      });
    }
  }
  menu.toggle(anchor, items);
}
