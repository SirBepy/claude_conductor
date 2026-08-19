import { html, render } from "lit-html";
import {
  loadStatuslineRows,
  saveStatuslineRows,
  loadStatuslineHideZero,
  saveStatuslineHideZero,
  activeProfile,
  profileMaxRows,
  profileDefaultRows,
  type StatuslineProfile,
} from "../../../sessions/session-statusbar-helpers";
import {
  type ChipType, STATIC_CHIPS, SECTION_LABELS, type SectionKey,
  TOOL_CHIP_TOOLS, isToolChip, chipToolName,
} from "../../../sessions/statusline-catalog";
import { toolLabel, toolSummary } from "../../../../shared/chat/tool-meta";
import { escapeHtml } from "../../../../shared/escape-html";
import { type Pos, insertChip, moveChip, removeAt, addRow, trimRows, moveRow } from "./statusline-dnd";
import { settingsHeader } from "../../ui";
import "../../settings.css";
import "./statusline.css";
import "../../../sessions/session-statusbar.css";
import "../../../sessions/session-statusbar-images.css";

interface ChipDisplay { icon: string; sample: string; tooltip: string; }

// Display metadata for any chip - static chips from the catalog, tool chips
// derived from the shared tool-meta so the palette/preview match the real bar.
function chipMeta(type: ChipType): ChipDisplay {
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

function chipHtml(type: ChipType, cls: string, extra = ""): string {
  const m = chipMeta(type);
  return `<span class="sb-chip sl-pchip ${cls}" data-type="${escapeHtml(type)}" ${extra} title="${escapeHtml(m.tooltip)}"><i class="ph ${m.icon}"></i>${escapeHtml(m.sample)}</span>`;
}

const SECTION_ORDER: SectionKey[] = ["model", "git", "session", "tools", "layout"];

function paletteChipsFor(section: SectionKey): ChipType[] {
  if (section === "tools") return TOOL_CHIP_TOOLS.map((t) => `tool:${t}` as ChipType);
  return (Object.keys(STATIC_CHIPS) as (keyof typeof STATIC_CHIPS)[])
    .filter((k) => STATIC_CHIPS[k].section === section) as ChipType[];
}

// Rendered via lit (not root.innerHTML) so the router's lit part markers on
// `root` survive. Clobbering them with innerHTML ejects lit's marker nodes and
// makes the next `render(html``, root)` on navigate-away throw.
function rowsHint(profile: StatuslineProfile): string {
  const n = profileMaxRows(profile);
  return `Drag chips from the palette into the bar. Reorder by dragging, remove by dragging a chip out of the bar. Up to ${n} row${n === 1 ? "" : "s"}.`;
}

const shell = (profile: StatuslineProfile) => html`
  <div class="view view-settings-statusline">
    ${settingsHeader("Statusline")}
    <div class="view-body">
      <div class="kit-section sl-section">
        <div class="kit-section-title">Which screen</div>
        <div class="kit-section-hint sl-hint">Desktop and phone keep separate layouts. The phone used to inherit this one, which is why it wrapped and clipped.</div>
        <div class="sl-profiles" id="slProfiles">
          <button class="sl-profile ${profile === "desktop" ? "on" : ""}" data-profile="desktop"><i class="ph ph-monitor"></i>Desktop</button>
          <button class="sl-profile ${profile === "mobile" ? "on" : ""}" data-profile="mobile"><i class="ph ph-device-mobile"></i>Mobile</button>
        </div>
      </div>

      <div class="kit-section sl-section">
        <div class="kit-section-title">Preview &amp; layout</div>
        <div class="kit-section-hint sl-hint" id="slRowsHint">${rowsHint(profile)}</div>
        <div class="sl-builder-chrome">
          <div class="sl-builder-titlebar">my-project — active session</div>
          <div class="session-statusbar sl-builder-bar" id="slBar"></div>
          <div class="sl-builder-body"><span>chat messages…</span></div>
        </div>
      </div>

      <div class="kit-section sl-section">
        <div class="kit-section-title">Palette</div>
        <div class="sl-palette" id="slPalette"></div>
      </div>

      <div class="kit-section sl-section">
        <label class="sl-hidezero">
          <input type="checkbox" id="slHideZero">
          Hide tool / count chips when they're zero
        </label>
      </div>

      <div class="kit-section" style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn-secondary" id="slClearBtn" style="font-size:0.8rem;">Clear all</button>
        <button class="btn-secondary" id="slResetBtn" style="font-size:0.8rem;">Reset to defaults</button>
      </div>
    </div>
  </div>
`;

export async function renderStatuslineView(root: HTMLElement): Promise<() => void> {
  // Opens on whichever profile this window currently renders, so the bar the
  // dev is looking at is the one the builder edits.
  let profile: StatuslineProfile = activeProfile();
  let rows = await loadStatuslineRows(profile);
  let hideZero = await loadStatuslineHideZero();

  render(shell(profile), root);
  const bar = root.querySelector<HTMLElement>("#slBar")!;
  const palette = root.querySelector<HTMLElement>("#slPalette")!;
  const hideZeroBox = root.querySelector<HTMLInputElement>("#slHideZero")!;
  hideZeroBox.checked = hideZero;

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const persist = () => {
    if (saveTimer) clearTimeout(saveTimer);
    // Snapshot both: a queued save must land against the profile and rows it
    // was scheduled for, even if the dev switches profiles inside the debounce.
    const p = profile;
    const snapshot = rows.map((r) => [...r]);
    saveTimer = setTimeout(() => void saveStatuslineRows(snapshot, p), 250);
  };

  async function switchProfile(next: StatuslineProfile): Promise<void> {
    if (next === profile) return;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; await saveStatuslineRows(rows, profile); }
    profile = next;
    rows = await loadStatuslineRows(profile);
    for (const b of root.querySelectorAll<HTMLElement>(".sl-profile")) {
      b.classList.toggle("on", b.dataset.profile === profile);
    }
    const hint = root.querySelector<HTMLElement>("#slRowsHint");
    if (hint) hint.textContent = rowsHint(profile);
    paint();
  }

  root.querySelector<HTMLElement>("#slProfiles")?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".sl-profile");
    if (btn?.dataset.profile) void switchProfile(btn.dataset.profile as StatuslineProfile);
  });

  // ── drag state ─────────────────────────────────────────────────────────────
  let drag: {
    type: ChipType;
    fromPlaced: Pos | null; // null => dragged from palette
    clone: HTMLElement;
  } | null = null;
  let onMove: ((e: PointerEvent) => void) | null = null;
  let onUp: ((e: PointerEvent) => void) | null = null;

  function paint(): void {
    const rowCount = rows.length;
    bar.innerHTML =
      rows.map((row, ri) => {
        const upBtn = ri > 0
          ? `<button class="sl-row-btn" data-action="up" data-ri="${ri}" title="Move row up">↑</button>`
          : `<span class="sl-row-btn-ph"></span>`;
        const downBtn = ri < rowCount - 1
          ? `<button class="sl-row-btn" data-action="down" data-ri="${ri}" title="Move row down">↓</button>`
          : `<span class="sl-row-btn-ph"></span>`;
        return `<div class="sl-row-wrap">`
          + `<div class="sl-row-controls">${upBtn}${downBtn}</div>`
          + `<div class="sb-row sl-row${row.length === 0 ? " sl-row-empty" : ""}" data-row="${ri}">`
          + row.map((type, ci) => chipHtml(type, "sl-placed", `data-row="${ri}" data-index="${ci}"`)).join("")
          + `</div>`
          + `</div>`;
      }).join("")
      + (rows.length < profileMaxRows(profile) ? `<button class="sl-addrow" id="slAddRow">+ row</button>` : "");

    palette.innerHTML = SECTION_ORDER.map((sec) =>
      `<div class="sl-palette-section">`
      + `<div class="sl-section-label">${escapeHtml(SECTION_LABELS[sec])}</div>`
      + `<div class="sl-palette-chips">`
      + paletteChipsFor(sec).map((type) => chipHtml(type, "sl-source")).join("")
      + `</div></div>`
    ).join("");

    wireChips();
    root.querySelector<HTMLButtonElement>("#slAddRow")?.addEventListener("click", () => {
      rows = addRow(rows, profileMaxRows(profile));
      paint();
    });
  }

  function wireChips(): void {
    root.querySelectorAll<HTMLElement>(".sl-pchip").forEach((chip) => {
      chip.addEventListener("pointerdown", (e) => startDrag(e, chip));
    });
    root.querySelectorAll<HTMLButtonElement>(".sl-row-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const ri = Number(btn.dataset.ri);
        if (btn.dataset.action === "up" && ri > 0) {
          rows = moveRow(rows, ri, ri - 1);
        } else if (btn.dataset.action === "down" && ri < rows.length - 1) {
          rows = moveRow(rows, ri, ri + 1);
        }
        paint();
        persist();
      });
    });
  }

  function startDrag(e: PointerEvent, chip: HTMLElement): void {
    e.preventDefault();
    const type = chip.dataset.type as ChipType;
    const placed = chip.classList.contains("sl-placed");
    const fromPlaced: Pos | null = placed
      ? { row: Number(chip.dataset.row), index: Number(chip.dataset.index) }
      : null;

    const clone = document.createElement("span");
    clone.className = "sb-chip sl-drag-clone";
    clone.innerHTML = chip.innerHTML;
    clone.style.left = `${e.clientX + 8}px`;
    clone.style.top = `${e.clientY + 8}px`;
    document.body.appendChild(clone);

    drag = { type, fromPlaced, clone };

    onMove = (ev: PointerEvent) => moveDrag(ev);
    onUp = (ev: PointerEvent) => endDrag(ev);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  // Find the row + insertion index under the pointer, or null if not over a row.
  function hitTest(x: number, y: number): Pos | null {
    if (typeof document.elementFromPoint !== "function") return null; // jsdom / no layout
    const rowEl = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>(".sl-row");
    if (!rowEl) return null;
    const ri = Number(rowEl.dataset.row);
    const chips = [...rowEl.querySelectorAll<HTMLElement>(".sl-placed")];
    let index = chips.length;
    for (let i = 0; i < chips.length; i++) {
      const c = chips[i];
      if (!c) continue;
      const r = c.getBoundingClientRect();
      if (x < r.left + r.width / 2) { index = i; break; }
    }
    return { row: ri, index };
  }

  function moveDrag(e: PointerEvent): void {
    if (!drag) return;
    drag.clone.style.left = `${e.clientX + 8}px`;
    drag.clone.style.top = `${e.clientY + 8}px`;
    const pos = hitTest(e.clientX, e.clientY);
    const removing = drag.fromPlaced !== null && pos === null;
    drag.clone.classList.toggle("sl-removing", removing);
    root.querySelectorAll<HTMLElement>(".sl-row.sl-drop-target").forEach((el) => el.classList.remove("sl-drop-target"));
    if (pos) {
      root.querySelector<HTMLElement>(`.sl-row[data-row="${pos.row}"]`)?.classList.add("sl-drop-target");
    }
  }

  function endDrag(e: PointerEvent): void {
    if (onMove) document.removeEventListener("pointermove", onMove);
    if (onUp) document.removeEventListener("pointerup", onUp);
    onMove = onUp = null;
    if (!drag) return;
    const { type, fromPlaced, clone } = drag;
    clone.remove();
    drag = null;

    const pos = hitTest(e.clientX, e.clientY);
    if (pos) {
      rows = fromPlaced ? moveChip(rows, fromPlaced, pos) : insertChip(rows, pos, type);
    } else if (fromPlaced) {
      rows = removeAt(rows, fromPlaced); // drag-out = remove
    } else {
      paint(); // palette chip dropped on nothing: no-op
      return;
    }
    rows = trimRows(rows);
    paint();
    persist();
  }

  // ── static wiring ──────────────────────────────────────────────────────────
  hideZeroBox.addEventListener("change", () => {
    hideZero = hideZeroBox.checked;
    void saveStatuslineHideZero(hideZero);
  });

  root.querySelector<HTMLButtonElement>("#slClearBtn")?.addEventListener("click", () => {
    rows = [[]];
    paint();
    persist();
  });

  root.querySelector<HTMLButtonElement>("#slResetBtn")?.addEventListener("click", () => {
    rows = profileDefaultRows(profile);
    hideZero = true;
    hideZeroBox.checked = true;
    void saveStatuslineHideZero(true);
    paint();
    persist();
  });

  paint();

  return () => {
    if (saveTimer) clearTimeout(saveTimer);
    if (onMove) document.removeEventListener("pointermove", onMove);
    if (onUp) document.removeEventListener("pointerup", onUp);
    drag?.clone.remove();
  };
}
