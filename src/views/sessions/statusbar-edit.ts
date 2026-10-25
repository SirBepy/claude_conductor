// In-place statusline editor. While active, the REAL bar of one chat shows its
// layout as editable chips (x to remove, drag to reorder, row controls, a "+"
// palette popover) and every change is saved straight through
// saveStatuslineRows / saveStatuslineHideZero. State is per-bar and in memory
// only: leaving edit mode drops it, the saved layout is the only record.
import { escapeHtml } from "../../shared/escape-html";
import { askConfirm } from "../../shared/confirm";
import { toolLabel, toolSummary } from "../../shared/chat/tool-meta";
import {
  type ChipType, STATIC_CHIPS, SECTION_LABELS, type SectionKey,
  TOOL_CHIP_TOOLS, isToolChip, chipToolName,
} from "./statusline-catalog";
import {
  loadStatuslineRows, saveStatuslineRows, saveStatuslineHideZero,
  activeProfile, profileMaxRows, profileDefaultRows, type StatuslineProfile,
} from "./session-statusbar-helpers";
import { PopoverShell } from "./statusbar-popover-shell";
import { type Pos, insertChip, moveChip, removeAt, addRow, trimRows, moveRow, removeRow } from "./statusline-dnd";
import "./statusbar-edit.css";

export interface StatusbarEditHost {
  container: HTMLElement;
  hideZero(): boolean;
  /** Re-run the statusbar's own render(), which asks the editor for its markup. */
  repaint(): void;
  /** One chip's real markup ("" when it has nothing to show right now). */
  chipRenderer(): (type: ChipType) => string;
  closePopovers(): void;
  /** A layout or hide-zero change that was just saved. */
  onLayout(rows: ChipType[][], profile: StatuslineProfile, hideZero: boolean): void;
}

const SECTION_ORDER: SectionKey[] = ["model", "git", "session", "tools", "layout"];
// A drag only starts after this much pointer travel, so a plain click on a
// palette chip adds it and a drag drops it where the pointer lands.
const DRAG_THRESHOLD = 4;

function chipMeta(type: ChipType): { icon: string; sample: string; tooltip: string } {
  if (isToolChip(type)) {
    const tool = chipToolName(type);
    return {
      icon: toolSummary(tool, {}).icon,
      sample: `${toolLabel(tool)} ×3`,
      tooltip: `How many ${toolLabel(tool)} tool calls ran this session.`,
    };
  }
  const m = STATIC_CHIPS[type as keyof typeof STATIC_CHIPS];
  return { icon: m.icon, sample: m.sample, tooltip: m.tooltip };
}

function paletteChipsFor(section: SectionKey): ChipType[] {
  if (section === "tools") return TOOL_CHIP_TOOLS.map((t) => `tool:${t}` as ChipType);
  return (Object.keys(STATIC_CHIPS) as (keyof typeof STATIC_CHIPS)[])
    .filter((k) => STATIC_CHIPS[k].section === section) as ChipType[];
}

/** Separators are chrome, not data: several in one bar is normal, so they stay
 *  in the palette after being placed. */
function repeatable(type: ChipType): boolean {
  return !isToolChip(type) && STATIC_CHIPS[type as keyof typeof STATIC_CHIPS].section === "layout";
}

export class StatusbarEditor {
  active = false;
  profile: StatuslineProfile = "desktop";
  rows: ChipType[][] = [[]];
  hideZero = true;

  private palette = new PopoverShell();
  private paletteOpen = false;
  private confirming = false;
  private suppressClick = false;
  private lastSave: Promise<void> = Promise.resolve();
  private teardown: (() => void) | null = null;
  private drag: { type: ChipType; from: Pos | null; start: { x: number; y: number }; clone: HTMLElement | null } | null = null;
  private dragTeardown: (() => void) | null = null;

  constructor(private host: StatusbarEditHost) {}

  async enter(): Promise<void> {
    if (this.active) return;
    this.active = true; // claim first so a second right-click during the load is a no-op
    this.profile = activeProfile();
    this.hideZero = this.host.hideZero();
    this.rows = await loadStatuslineRows(this.profile);
    if (!this.active) return;
    this.host.closePopovers();
    this.host.container.classList.add("sb-editing");
    this.listen();
    this.host.repaint();
  }

  exit(): void {
    if (!this.active) return;
    this.active = false;
    this.cancelDrag();
    this.teardown?.();
    this.teardown = null;
    this.palette.close();
    this.paletteOpen = false;
    this.host.container.classList.remove("sb-editing");
    this.host.repaint();
  }

  /** Resolves once every save fired so far has landed. */
  flush(): Promise<void> { return this.lastSave; }

  // ── markup ───────────────────────────────────────────────────────────────
  html(): string {
    const render = this.host.chipRenderer();
    const chipHtml = (type: ChipType, ri: number, ci: number): string => {
      const real = repeatable(type) ? "" : render(type);
      const m = chipMeta(type);
      // A chip with nothing to show right now (zero count, not at a drifted
      // location, no second account...) still needs a handle to move or remove.
      const dim = !real && !repeatable(type);
      const body = real || `<span class="sb-chip sb-edit-ph"><i class="ph ${m.icon}"></i>${escapeHtml(m.sample)}</span>`;
      return `<span class="sb-edit-chip${dim ? " sb-edit-dim" : ""}" data-type="${escapeHtml(type)}" data-row="${ri}" data-index="${ci}" title="${escapeHtml(m.tooltip)}">`
        + body
        + `<button class="sb-edit-x" data-act="chip-x" aria-label="Remove chip"><i class="ph ph-x"></i></button>`
        + `</span>`;
    };
    const rowsHtml = this.rows.map((row, ri) => {
      const up = ri > 0
        ? `<button class="sb-edit-rowbtn" data-act="row-up" data-ri="${ri}" title="Move row up" aria-label="Move row up"><i class="ph ph-caret-up"></i></button>`
        : `<span class="sb-edit-rowbtn-ph"></span>`;
      const down = ri < this.rows.length - 1
        ? `<button class="sb-edit-rowbtn" data-act="row-down" data-ri="${ri}" title="Move row down" aria-label="Move row down"><i class="ph ph-caret-down"></i></button>`
        : `<span class="sb-edit-rowbtn-ph"></span>`;
      const del = `<button class="sb-edit-rowbtn" data-act="row-del" data-ri="${ri}" title="Remove row" aria-label="Remove row"><i class="ph ph-minus-circle"></i></button>`;
      return `<div class="sb-edit-row-wrap">`
        + `<div class="sb-edit-rowctl">${up}${down}${del}</div>`
        + `<div class="sb-row sb-edit-row${row.length ? "" : " sb-edit-row-empty"}" data-row="${ri}">`
        + row.map((t, ci) => chipHtml(t, ri, ci)).join("")
        + `</div></div>`;
    }).join("");
    const canAddRow = this.rows.length < profileMaxRows(this.profile);
    return `<div class="sb-rows">${rowsHtml}</div>`
      + `<div class="sb-edit-tools">`
      + (canAddRow ? `<button class="sb-edit-btn" data-act="add-row">+ row</button>` : "")
      + `<button class="sb-edit-btn" data-act="palette" aria-label="Add chips" title="Add chips"><i class="ph ph-plus"></i></button>`
      + `<button class="sb-edit-btn sb-edit-done" data-act="done">Done</button>`
      + `</div>`;
  }

  /** Called by the statusbar right after it wrote `html()` into the container. */
  afterPaint(): void {
    if (this.paletteOpen) this.openPalette();
  }

  private paletteHtml(): string {
    const placed = new Set(this.rows.flat());
    const sections = SECTION_ORDER.map((sec) => {
      const chips = paletteChipsFor(sec).filter((t) => repeatable(t) || !placed.has(t));
      if (!chips.length) return "";
      return `<div class="sb-edit-pal-sec"><div class="sb-edit-pal-label">${escapeHtml(SECTION_LABELS[sec])}</div>`
        + `<div class="sb-edit-pal-chips">`
        + chips.map((t) => {
          const m = chipMeta(t);
          return `<span class="sb-chip sb-edit-source" data-type="${escapeHtml(t)}" title="${escapeHtml(m.tooltip)}"><i class="ph ${m.icon}"></i>${escapeHtml(m.sample)}</span>`;
        }).join("")
        + `</div></div>`;
    }).join("");
    const seg = (p: StatuslineProfile, icon: string, label: string) =>
      `<button class="sb-edit-segbtn${this.profile === p ? " on" : ""}" data-profile="${p}"><i class="ph ${icon}"></i>${label}</button>`;
    return `<div class="sb-edit-pal-body">${sections || `<div class="sb-edit-pal-label">Every chip is already placed</div>`}</div>`
      + `<div class="sb-edit-pal-foot">`
      + `<div class="sb-edit-seg">${seg("desktop", "ph-monitor", "Desktop")}${seg("mobile", "ph-device-mobile", "Mobile")}</div>`
      + `<label class="sb-edit-hz"><input type="checkbox" data-act="hidezero"${this.hideZero ? " checked" : ""}> Hide tool / count chips when zero</label>`
      + `<div class="sb-edit-pal-btns">`
      + `<button class="sb-edit-btn" data-act="clear">Clear all</button>`
      + `<button class="sb-edit-btn" data-act="reset">Reset to defaults</button>`
      + `</div></div>`;
  }

  private openPalette(): void {
    this.paletteOpen = true;
    // Anchored on the whole bar, not the "+": the shell's outside-click rule
    // then treats the bar's own x buttons and drags as inside, so the palette
    // survives edits instead of closing on every one.
    this.palette.open(this.host.container, this.paletteHtml(), {
      className: "sb-edit-palette",
      onClose: () => { this.paletteOpen = false; },
      wire: (el) => this.wirePalette(el),
    });
  }

  // ── changes ──────────────────────────────────────────────────────────────
  private persist(): void {
    const snapshot = this.rows.map((r) => [...r]);
    const profile = this.profile;
    this.lastSave = this.lastSave.then(() => saveStatuslineRows(snapshot, profile));
    this.host.onLayout(snapshot.filter((r) => r.length > 0), profile, this.hideZero);
  }

  private commit(next: ChipType[][], trim = true): void {
    this.rows = trim ? trimRows(next) : next;
    this.host.repaint();
    this.persist();
  }

  private async switchProfile(next: StatuslineProfile): Promise<void> {
    if (next === this.profile) return;
    await this.lastSave;
    this.profile = next;
    this.rows = await loadStatuslineRows(next);
    this.host.repaint();
  }

  private setHideZero(v: boolean): void {
    this.hideZero = v;
    this.lastSave = this.lastSave.then(() => saveStatuslineHideZero(v));
    this.host.onLayout(this.rows.filter((r) => r.length > 0), this.profile, v);
    this.host.repaint();
  }

  private addChip(type: ChipType): void {
    const last = Math.max(0, this.rows.length - 1);
    this.commit(insertChip(this.rows, { row: last, index: this.rows[last]?.length ?? 0 }, type));
  }

  private async clearAll(): Promise<void> {
    this.confirming = true;
    let ok = false;
    try { ok = await askConfirm("Clear the whole layout?", { confirmLabel: "Clear" }); }
    finally { this.confirming = false; }
    if (ok && this.active) this.commit([[]]);
  }

  private reset(): void {
    this.rows = profileDefaultRows(this.profile);
    this.hideZero = true;
    this.lastSave = this.lastSave.then(() => saveStatuslineHideZero(true));
    this.host.repaint();
    this.persist();
  }

  // ── wiring ───────────────────────────────────────────────────────────────
  private onAction(btn: HTMLElement): void {
    const ri = Number(btn.dataset.ri);
    switch (btn.dataset.act) {
      case "chip-x": {
        const chip = btn.closest<HTMLElement>(".sb-edit-chip");
        if (chip) this.commit(removeAt(this.rows, { row: Number(chip.dataset.row), index: Number(chip.dataset.index) }));
        break;
      }
      case "row-up": this.commit(moveRow(this.rows, ri, ri - 1), false); break;
      case "row-down": this.commit(moveRow(this.rows, ri, ri + 1), false); break;
      case "row-del": this.commit(removeRow(this.rows, ri), false); break;
      case "add-row":
        this.rows = addRow(this.rows, profileMaxRows(this.profile));
        this.host.repaint(); // an empty row is a drop target, not a layout worth saving
        break;
      case "palette":
        if (this.paletteOpen) { this.palette.close(); } else { this.openPalette(); }
        break;
      case "done": this.exit(); break;
    }
  }

  private listen(): void {
    const c = this.host.container;
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
      if (btn && c.contains(btn)) { e.stopPropagation(); this.onAction(btn); }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (e.button !== 0 || t.closest("[data-act]")) return;
      const chip = t.closest<HTMLElement>(".sb-edit-chip");
      if (!chip) return;
      this.beginDrag(e, chip.dataset.type as ChipType,
        { row: Number(chip.dataset.row), index: Number(chip.dataset.index) });
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") this.exit(); };
    // Capture phase so it sees a click before the confirm dialog or a chip's
    // own handlers do. Registered a tick late: the click that opened edit mode
    // (the menu item) must not count as "outside".
    const onOutside = (e: MouseEvent) => {
      if (this.suppressClick) return;
      const t = e.target as HTMLElement | null;
      if (!t || this.confirming || !t.isConnected) return;
      if (c.contains(t) || t.closest(".sb-edit-palette") || t.closest(".app-confirm-overlay")) return;
      this.exit();
    };
    c.addEventListener("click", onClick);
    c.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    const timer = setTimeout(() => document.addEventListener("click", onOutside, true), 0);
    this.teardown = () => {
      clearTimeout(timer);
      c.removeEventListener("click", onClick);
      c.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onOutside, true);
    };
  }

  private wirePalette(el: HTMLElement): void {
    el.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (this.suppressClick) return;
      const src = t.closest<HTMLElement>(".sb-edit-source");
      if (src) { this.addChip(src.dataset.type as ChipType); return; }
      const seg = t.closest<HTMLElement>("[data-profile]");
      if (seg) { void this.switchProfile(seg.dataset.profile as StatuslineProfile); return; }
      const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act === "clear") void this.clearAll();
      else if (act === "reset") this.reset();
    });
    el.addEventListener("change", (e) => {
      const box = e.target as HTMLInputElement;
      if (box.dataset.act === "hidezero") this.setHideZero(box.checked);
    });
    el.addEventListener("pointerdown", (e) => {
      const src = (e.target as HTMLElement).closest<HTMLElement>(".sb-edit-source");
      if (src && e.button === 0) this.beginDrag(e, src.dataset.type as ChipType, null);
    });
  }

  // ── drag ─────────────────────────────────────────────────────────────────
  private beginDrag(e: PointerEvent, type: ChipType, from: Pos | null): void {
    this.cancelDrag();
    this.drag = { type, from, start: { x: e.clientX, y: e.clientY }, clone: null };
    const onMove = (ev: PointerEvent) => this.moveDrag(ev);
    const onUp = (ev: PointerEvent) => this.endDrag(ev);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    this.dragTeardown = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
  }

  private cancelDrag(): void {
    this.dragTeardown?.();
    this.dragTeardown = null;
    this.drag?.clone?.remove();
    this.drag = null;
    this.host.container.querySelectorAll(".sb-edit-drop").forEach((x) => x.classList.remove("sb-edit-drop"));
  }

  private hitTest(x: number, y: number): Pos | null {
    if (typeof document.elementFromPoint !== "function") return null; // jsdom has no layout
    const rowEl = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>(".sb-edit-row");
    if (!rowEl || !this.host.container.contains(rowEl)) return null;
    const chips = [...rowEl.querySelectorAll<HTMLElement>(".sb-edit-chip")];
    let index = chips.length;
    for (let i = 0; i < chips.length; i++) {
      const r = chips[i]!.getBoundingClientRect();
      if (x < r.left + r.width / 2) { index = i; break; }
    }
    return { row: Number(rowEl.dataset.row), index };
  }

  private moveDrag(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    if (!d.clone) {
      if (Math.hypot(e.clientX - d.start.x, e.clientY - d.start.y) < DRAG_THRESHOLD) return;
      const m = chipMeta(d.type);
      const clone = document.createElement("span");
      clone.className = "sb-chip sb-drag-clone";
      clone.innerHTML = `<i class="ph ${m.icon}"></i>${escapeHtml(m.sample)}`;
      document.body.appendChild(clone);
      d.clone = clone;
    }
    d.clone.style.left = `${e.clientX + 8}px`;
    d.clone.style.top = `${e.clientY + 8}px`;
    const pos = this.hitTest(e.clientX, e.clientY);
    d.clone.classList.toggle("sb-removing", d.from !== null && pos === null);
    this.host.container.querySelectorAll(".sb-edit-drop").forEach((x) => x.classList.remove("sb-edit-drop"));
    if (pos) this.host.container.querySelector(`.sb-edit-row[data-row="${pos.row}"]`)?.classList.add("sb-edit-drop");
  }

  private endDrag(e: PointerEvent): void {
    const d = this.drag;
    const dragged = !!d?.clone;
    this.cancelDrag();
    if (!d || !dragged) return; // never crossed the threshold: it was a click
    // The click that follows this pointerup can land outside the bar.
    this.suppressClick = true;
    setTimeout(() => { this.suppressClick = false; }, 0);
    const pos = this.hitTest(e.clientX, e.clientY);
    if (pos) this.commit(d.from ? moveChip(this.rows, d.from, pos) : insertChip(this.rows, pos, d.type));
    else if (d.from) this.commit(removeAt(this.rows, d.from)); // drag-out = remove
  }
}
