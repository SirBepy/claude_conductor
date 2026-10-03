// Right-click menu for Code mode's file tree. On a file: things to do with
// that file. On empty space: folder-wide expand / collapse, which is why the
// explorer header has no buttons for them.

import { invoke } from "../../../shared/ipc";
import { isRemote } from "../../../shared/transport";

export type TreeMenuTarget =
  | { kind: "file"; relPath: string; absPath: string; onMention: ((relPath: string) => void) | null }
  | { kind: "space"; onExpandAll: () => void; onCollapseAll: () => void };

let menuEl: HTMLElement | null = null;

export function closeTreeContextMenu(): void {
  menuEl?.remove();
  menuEl = null;
  document.removeEventListener("mousedown", onOutside, true);
  document.removeEventListener("keydown", onKey, true);
}

function onOutside(e: MouseEvent): void {
  if (menuEl && !menuEl.contains(e.target as Node)) closeTreeContextMenu();
}

function onKey(e: KeyboardEvent): void {
  if (!menuEl) return;
  const items = Array.from(menuEl.querySelectorAll<HTMLElement>(".cm-mi"));
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeTreeContextMenu();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  } else if (e.key === "Enter" && i >= 0) {
    e.preventDefault();
    items[i]!.click();
  }
}

const item = (act: string, icon: string, label: string) =>
  `<div class="cm-mi" role="menuitem" tabindex="-1" data-ctx="${act}"><i class="ph ${icon}"></i>${label}</div>`;

export function openTreeContextMenu(x: number, y: number, target: TreeMenuTarget): void {
  closeTreeContextMenu();
  const el = document.createElement("div");
  el.className = "cm-ctx";
  el.setAttribute("role", "menu");
  if (target.kind === "file") {
    // VS Code and the file manager live on the desktop's disk; the phone has none.
    const desktop = !isRemote();
    el.innerHTML = (target.onMention ? item("mention", "ph-at", "Mention in chat") : "")
      + (desktop ? item("vscode", "ph-arrow-square-out", "Open in VS Code") + item("reveal", "ph-folder-open", "Show in File Explorer") : "")
      + (target.onMention || desktop ? `<div class="cm-sep"></div>` : "")
      + item("copy", "ph-copy", "Copy path")
      + item("copyrel", "ph-copy-simple", "Copy relative path");
  } else {
    el.innerHTML = item("expand", "ph-arrows-out-line-vertical", "Expand all folders")
      + item("collapse", "ph-arrows-in-line-vertical", "Collapse all folders");
  }
  el.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-ctx]")?.dataset.ctx;
    if (!act) return;
    closeTreeContextMenu();
    run(act, target);
  });
  document.body.appendChild(el);
  // Keep it on screen: a right-click near the bottom/right edge opens up/left.
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  menuEl = el;
  el.querySelector<HTMLElement>(".cm-mi")?.focus();
  document.addEventListener("mousedown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
}

function run(act: string, t: TreeMenuTarget): void {
  if (t.kind === "space") {
    if (act === "expand") t.onExpandAll();
    else if (act === "collapse") t.onCollapseAll();
    return;
  }
  const winPath = (p: string) => (/^[a-z]:\//i.test(p) ? p.replace(/\//g, "\\") : p);
  switch (act) {
    case "mention": t.onMention?.(t.relPath); break;
    case "vscode":
      void invoke<void>("open_in_editor", { path: t.absPath }).catch((err) => console.error("[code-mode] open_in_editor failed", err));
      break;
    case "reveal":
      void invoke<void>("reveal_file_in_explorer", { path: winPath(t.absPath) }).catch((err) => console.error("[code-mode] reveal failed", err));
      break;
    case "copy": void navigator.clipboard?.writeText(winPath(t.absPath)).catch(() => {}); break;
    case "copyrel": void navigator.clipboard?.writeText(t.relPath).catch(() => {}); break;
  }
}
