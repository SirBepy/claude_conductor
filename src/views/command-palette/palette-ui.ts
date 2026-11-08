// Ctrl+Shift+P: one search box over every action. The overlay is source-agnostic
// (index.ts supplies the sources) so it can be tested without the Chats view.

import "./command-palette.css";
import { lockInputToHost } from "../../shared/modal-input-lock";
import { showToast } from "../../shared/toast";
import { escapeHtml } from "../../shared/escape-html";
import { rankCommands } from "./rank";
import { clampPosition, clearPosition, loadPosition, savePosition, type PalettePosition } from "./position";
import { loadRecents, pushRecent } from "./recents";
import { isRunnable, type PaletteCommand, type PaletteStage } from "./types";

export interface PaletteSources {
  /** Read at open time; rows appear on the first paint. */
  sync: () => PaletteCommand[];
  /** Slower reads (the project list). Rows are added as each one lands; a read that throws adds nothing. */
  later: Array<() => Promise<PaletteCommand[]>>;
  /** The search box's hint; a palette scoped to one chat names it here. */
  placeholder?: string;
}

const DEFAULT_PLACEHOLDER = "Search commands, chats, projects and settings";

let current: { close(): void } | null = null;

export function isPaletteOpen(): boolean {
  return current !== null;
}

export function closePalette(): void {
  current?.close();
}

function keycaps(keys: string): string {
  return keys
    .split("+")
    .map((k) => `<kbd class="cp-key">${escapeHtml(k.charAt(0).toUpperCase() + k.slice(1))}</kbd>`)
    .join("");
}

function rowHtml(c: PaletteCommand, index: number, selected: boolean): string {
  const dead = !isRunnable(c);
  const detail = dead && c.disabledReason ? c.disabledReason : c.detail;
  return `<div class="cp-row${selected ? " selected" : ""}${dead ? " disabled" : ""}" role="option" data-index="${index}">`
    + `<i class="ph ph-${escapeHtml(c.icon)}"></i>`
    + `<span class="cp-title">${escapeHtml(c.title)}</span>`
    + (detail ? `<span class="cp-detail">${escapeHtml(detail)}</span>` : "")
    + `<span class="cp-spacer"></span>`
    + `<span class="cp-group">${escapeHtml(c.group)}</span>`
    + (c.keys ? `<span class="cp-keys">${keycaps(c.keys)}</span>` : "")
    + `</div>`;
}

export function openPalette(sources: PaletteSources): void {
  if (current) return;

  const overlay = document.createElement("div");
  overlay.className = "cp-overlay";
  overlay.innerHTML = `<div class="cp" role="dialog" aria-label="Command palette">`
    + `<div class="cp-grip" title="Drag to move, double-click to recentre"><i class="ph ph-dots-six"></i></div>`
    + `<div class="cp-field"><i class="ph ph-magnifying-glass cp-lead"></i>`
    + `<input class="cp-input" aria-label="Search commands" spellcheck="false" autocomplete="off" /></div>`
    + `<div class="cp-list" role="listbox"></div>`
    + `<div class="cp-error" hidden></div>`
    + `</div>`;
  const input = overlay.querySelector<HTMLInputElement>(".cp-input")!;
  const list = overlay.querySelector<HTMLElement>(".cp-list")!;
  const lead = overlay.querySelector<HTMLElement>(".cp-lead")!;
  const errorBox = overlay.querySelector<HTMLElement>(".cp-error")!;
  const rootPlaceholder = sources.placeholder ?? DEFAULT_PLACEHOLDER;
  input.placeholder = rootPlaceholder;

  const recents = loadRecents();
  let root: PaletteCommand[] = sources.sync();
  let stage: { def: PaletteStage; items: PaletteCommand[] | null; failed: string | null } | null = null;
  let shown: PaletteCommand[] = [];
  let sel = 0;
  let busy = false;

  function commands(): PaletteCommand[] | null {
    return stage ? stage.items : root;
  }

  function setError(text: string | null): void {
    errorBox.hidden = text === null;
    errorBox.textContent = text ?? "";
  }

  function render(): void {
    list.replaceChildren();
    const all = commands();
    const note = stage?.failed ?? (all === null ? "Loading..." : shown.length ? null : "No matching commands");
    if (note) {
      const empty = document.createElement("div");
      empty.className = "cp-empty";
      empty.textContent = note;
      list.appendChild(empty);
      return;
    }
    const sectioned = !stage && !input.value.trim() && recents.some((id) => root.some((c) => c.id === id));
    const recentIds = new Set(recents);
    let html = "";
    let phase: "recent" | "rest" | null = null;
    shown.forEach((c, i) => {
      if (sectioned) {
        const next = recentIds.has(c.id) && isRunnable(c) ? "recent" : "rest";
        if (next !== phase) {
          phase = next;
          html += `<div class="cp-section">${next === "recent" ? "Recent" : "All commands"}</div>`;
        }
      }
      html += rowHtml(c, i, i === sel);
    });
    list.innerHTML = html;
    list.querySelector(".cp-row.selected")?.scrollIntoView({ block: "nearest" });
  }

  function refilter(resetSel: boolean): void {
    const all = commands();
    shown = all ? rankCommands(all, input.value, stage ? [] : recents) : [];
    sel = resetSel ? 0 : Math.min(sel, Math.max(shown.length - 1, 0));
    render();
  }

  function move(dir: 1 | -1): void {
    if (!shown.length) return;
    sel = (sel + dir + shown.length) % shown.length;
    render();
  }

  function enterStage(def: PaletteStage): void {
    stage = { def, items: null, failed: null };
    input.value = "";
    input.placeholder = def.placeholder;
    lead.className = "ph ph-arrow-left cp-lead cp-back";
    setError(null);
    refilter(true);
    const mine = stage;
    def.load()
      .then((items) => { mine.items = items; })
      .catch((err) => { mine.items = []; mine.failed = `Couldn't load: ${String(err)}`; })
      .finally(() => { if (stage === mine) refilter(true); });
  }

  function leaveStage(): void {
    stage = null;
    input.value = "";
    input.placeholder = rootPlaceholder;
    lead.className = "ph ph-magnifying-glass cp-lead";
    setError(null);
    refilter(true);
  }

  async function pick(i: number): Promise<void> {
    const c = shown[i];
    if (!c || busy || !isRunnable(c)) return;
    // Only root rows are remembered: a branch name is not a command to come back to.
    if (!stage) pushRecent(c.id);
    if (c.stage) {
      enterStage(c.stage);
      return;
    }
    if (stage) {
      // A stage row's action can fail on git's own say-so; keep the palette open so the text is readable.
      busy = true;
      setError(null);
      try {
        await c.run!();
        close();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        busy = false;
      }
      return;
    }
    // Closed before it runs: most commands open their own modal or move focus,
    // and the palette's input lock would swallow both.
    close();
    try {
      await c.run!();
    } catch (err) {
      showToast(`${c.title} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Window capture runs ahead of every other keydown handler, same as Go to file.
  function onKey(e: KeyboardEvent): void {
    const palette = (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p";
    if (e.key === "Escape" || palette) close();
    else if (e.key === "Enter") void pick(sel);
    else if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "Backspace" && stage && input.value === "") leaveStage();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  const unlock = lockInputToHost(overlay);

  function close(): void {
    if (current !== handle) return;
    current = null;
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", onResize);
    unlock();
    overlay.remove();
  }
  const handle = { close };
  current = handle;

  input.addEventListener("input", () => refilter(true));
  lead.addEventListener("click", () => { if (stage) leaveStage(); });
  list.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".cp-row");
    if (row) void pick(Number(row.dataset.index));
  });
  list.addEventListener("mousemove", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".cp-row");
    const i = row ? Number(row.dataset.index) : sel;
    if (i === sel) return;
    sel = i;
    list.querySelectorAll(".cp-row").forEach((r) => r.classList.toggle("selected", Number((r as HTMLElement).dataset.index) === sel));
  });
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  window.addEventListener("keydown", onKey, true);

  const panel = overlay.querySelector<HTMLElement>(".cp")!;
  const grip = overlay.querySelector<HTMLElement>(".cp-grip")!;

  // The clamped spot the panel is at now, so a drag saves what is shown, not a re-measure.
  let placed: PalettePosition | null = null;
  function place(pos: PalettePosition | null): void {
    if (!pos) {
      placed = null;
      panel.classList.remove("placed");
      panel.style.left = panel.style.top = "";
      panel.style.removeProperty("--cp-room");
      return;
    }
    const box = panel.getBoundingClientRect();
    const at = clampPosition(pos, { width: box.width, height: box.height }, { width: window.innerWidth, height: window.innerHeight });
    panel.classList.add("placed");
    panel.style.left = `${at.left}px`;
    panel.style.top = `${at.top}px`;
    // The list shrinks to the room left below the panel, so a panel parked low stays readable.
    panel.style.setProperty("--cp-room", `${Math.max(window.innerHeight - at.top - 90, 120)}px`);
    placed = at;
  }

  let dragFrom: { x: number; y: number; left: number; top: number } | null = null;
  grip.addEventListener("pointerdown", (e) => {
    const box = panel.getBoundingClientRect();
    dragFrom = { x: e.clientX, y: e.clientY, left: box.left, top: box.top };
    // Capture keeps the drag alive when the pointer outruns the panel.
    grip.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  grip.addEventListener("pointermove", (e) => {
    if (!dragFrom) return;
    place({ left: dragFrom.left + e.clientX - dragFrom.x, top: dragFrom.top + e.clientY - dragFrom.y });
  });
  const endDrag = () => {
    if (!dragFrom) return;
    dragFrom = null;
    if (placed) savePosition(placed);
    input.focus();
  };
  grip.addEventListener("pointerup", endDrag);
  grip.addEventListener("pointercancel", endDrag);
  grip.addEventListener("dblclick", () => {
    clearPosition();
    place(null);
  });
  // A smaller window than the one the spot was saved in must not strand the panel off screen.
  const onResize = () => { const p = loadPosition(); if (p) place(p); };
  window.addEventListener("resize", onResize);

  document.body.appendChild(overlay);
  place(loadPosition());
  input.focus();
  refilter(true);

  for (const read of sources.later) {
    read()
      .then((more) => {
        if (current !== handle) return;
        const have = new Set(root.map((c) => c.id));
        root = [...root, ...more.filter((c) => !have.has(c.id))];
        if (!stage) refilter(false);
      })
      .catch(() => { /* a slow source failing leaves the rest of the palette intact */ });
  }
}
