// Ctrl+P: VS Code's Go to file. Fuzzy-matches the chat's repo files with the
// same ranking as the @ mention popup and hands the pick to the caller, which
// opens it in Code mode. Escape or a backdrop click closes it with no pick.

import "./quick-open.css";
import { invoke } from "../../../shared/ipc";
import { lockInputToHost } from "../../../shared/modal-input-lock";
import { matchFiles } from "../../../shared/chat/caret-popup/match-files";

let current: { close(): void } | null = null;

export function isQuickOpenOpen(): boolean {
  return current !== null;
}

export function openQuickOpen(cwd: string, onPick: (relPath: string) => void): void {
  if (current) return;

  const overlay = document.createElement("div");
  overlay.className = "quick-open-overlay";
  overlay.innerHTML = `<div class="quick-open" role="dialog" aria-label="Go to file">`
    + `<div class="qo-field"><i class="ph ph-magnifying-glass"></i>`
    + `<input class="qo-input" placeholder="Search files by name" aria-label="Search files by name" spellcheck="false" autocomplete="off" /></div>`
    + `<div class="qo-list" role="listbox"></div>`
    + `</div>`;
  const input = overlay.querySelector<HTMLInputElement>(".qo-input")!;
  const list = overlay.querySelector<HTMLElement>(".qo-list")!;

  let files: string[] | null = null;
  let error: string | null = null;
  let shown: string[] = [];
  let sel = 0;

  function render(): void {
    list.replaceChildren();
    const note = error ?? (files === null ? "Loading files..." : shown.length ? null : "No matching files");
    if (note) {
      const empty = document.createElement("div");
      empty.className = "qo-empty";
      empty.textContent = note;
      list.appendChild(empty);
      return;
    }
    shown.forEach((p, i) => {
      const slash = p.lastIndexOf("/");
      const row = document.createElement("div");
      row.className = i === sel ? "qo-row selected" : "qo-row";
      row.setAttribute("role", "option");
      row.dataset.index = String(i);
      const icon = document.createElement("i");
      icon.className = "ph ph-file";
      const base = document.createElement("span");
      base.className = "qo-base";
      base.textContent = slash < 0 ? p : p.slice(slash + 1);
      const dir = document.createElement("span");
      dir.className = "qo-dir";
      dir.textContent = slash < 0 ? "" : p.slice(0, slash);
      row.append(icon, base, dir);
      list.appendChild(row);
    });
    list.querySelector(".qo-row.selected")?.scrollIntoView({ block: "nearest" });
  }

  function refilter(): void {
    shown = files ? matchFiles(files, input.value.trim()) : [];
    sel = 0;
    render();
  }

  function move(dir: 1 | -1): void {
    if (!shown.length) return;
    sel = (sel + dir + shown.length) % shown.length;
    render();
  }

  function pick(i: number): void {
    const path = shown[i];
    if (path === undefined) return;
    close();
    onPick(path);
  }

  // Window capture runs ahead of Code mode's document-capture handler, whose
  // bare Escape would otherwise leave Code mode along with this picker.
  function onKey(e: KeyboardEvent): void {
    const ctrlP = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p";
    if (e.key === "Escape") close();
    else if (e.key === "Enter") pick(sel);
    else if (e.key === "ArrowDown" || ctrlP) move(e.shiftKey && ctrlP ? -1 : 1);
    else if (e.key === "ArrowUp") move(-1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  const unlock = lockInputToHost(overlay);

  function close(): void {
    if (current !== handle) return;
    current = null;
    window.removeEventListener("keydown", onKey, true);
    unlock();
    overlay.remove();
  }
  const handle = { close };
  current = handle;

  input.addEventListener("input", refilter);
  list.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".qo-row");
    if (row) pick(Number(row.dataset.index));
  });
  list.addEventListener("mousemove", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".qo-row");
    const i = row ? Number(row.dataset.index) : sel;
    if (i === sel) return;
    sel = i;
    list.querySelectorAll(".qo-row").forEach((r, n) => r.classList.toggle("selected", n === sel));
  });
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  window.addEventListener("keydown", onKey, true);

  document.body.appendChild(overlay);
  input.focus();
  render();

  invoke<string[]>("list_project_files", { projectDir: cwd })
    .then((all) => { files = all.map((p) => p.replace(/\\/g, "/")); })
    .catch((err) => { error = `Couldn't list files: ${String(err)}`; files = []; })
    .finally(() => { if (current === handle) refilter(); });
}
