import { html, render } from "lit-html";
import * as shortcuts from "../../../../shared/shortcuts";
import { normalizeEvent, SHORTCUT_RANGES } from "../../../../shared/shortcuts";
import type { ShortcutDef } from "../../../../shared/shortcuts";
import { modelShortcutLabel, modelShortcutSlot } from "../../../../shared/model-shortcuts";
import { settingsHeader } from "../../ui";
import "./shortcuts.css";

// A row is either one shortcut or a whole numbered family (Open chat 1-9).
// Rebind/capture state is keyed by `key`: the def id, or the range prefix.
interface Row {
  key: string;
  label: string;
  description: string;
  range: boolean;
}

interface ShortcutsUIState {
  capturingKey: string | null;
  conflictMsg: string | null;
  captureListener: ((e: KeyboardEvent) => void) | null;
}

function cap(k: string): string {
  return k.charAt(0).toUpperCase() + k.slice(1);
}

// A model slot's static def label names the seed list's model, which the live
// list can reorder, so the conflict message reads the same derived name the row shows.
function conflictLabel(d: ShortcutDef): string {
  const slot = modelShortcutSlot(d.id);
  return (slot === null ? null : modelShortcutLabel(slot)) ?? d.label;
}

function rowsFor(defs: ShortcutDef[]): Row[] {
  const rows: Row[] = [];
  for (const d of defs) {
    const range = SHORTCUT_RANGES.find(r => d.id.startsWith(r.prefix));
    if (!range) {
      const slot = modelShortcutSlot(d.id);
      if (slot === null) {
        rows.push({ key: d.id, label: d.label, description: d.description, range: false });
        continue;
      }
      // A model slot is named after what it picks now; one past the list picks nothing.
      const label = modelShortcutLabel(slot);
      if (label) rows.push({ key: d.id, label, description: d.description, range: false });
    } else if (d.id === `${range.prefix}1`) {
      rows.push({ key: range.prefix, label: range.label, description: range.description, range: true });
    }
  }
  return rows;
}

function bindingParts(row: Row): string[] {
  if (!row.range) return shortcuts.getBinding(row.key).split("+").map(cap);
  const mods = shortcuts.getRangeModifiers(row.key);
  return [...(mods ? mods.split("+").map(cap) : []), "1...9"];
}

function renderShortcutsList(container: HTMLElement): () => void {
  const s: ShortcutsUIState = { capturingKey: null, conflictMsg: null, captureListener: null };

  const re = () => {
    const defs = shortcuts.getAll();
    const globalRows = rowsFor(defs.filter(d => !d.context));
    const chatsRows = rowsFor(defs.filter(d => d.context === "sessions"));

    const rowTpl = (row: Row) => {
      const isCapturing = s.capturingKey === row.key;
      const hasOverride = row.range ? shortcuts.rangeHasOverride(row.key) : shortcuts.hasOverride(row.key);
      return html`
        <div class="shortcut-row" data-id=${row.key}>
          <div class="shortcut-row-info">
            <span class="shortcut-row-label">${row.label}</span>
            <span class="shortcut-row-desc">${row.description}</span>
          </div>
          <div class="shortcut-row-controls">
            <div>
              ${isCapturing
                ? html`<span class="shortcut-capture-input">Press a key combo...</span>`
                : html`<span class="shortcut-kbd">${bindingParts(row).map((k, i) => html`${i ? "+" : ""}<kbd>${k}</kbd>`)}</span>`}
              ${isCapturing && s.conflictMsg ? html`<div class="shortcut-conflict-msg">${s.conflictMsg}</div>` : ""}
            </div>
            <button class="shortcut-rebind-btn" data-rebind=${row.key} @click=${() => (isCapturing ? stopCapture() : startCapture(row))}>${isCapturing ? "Cancel" : "Rebind"}</button>
            ${hasOverride
              ? html`<button class="shortcut-reset-btn" data-reset=${row.key} title="Reset to default" @click=${() => {
                  if (row.range) shortcuts.resetRange(row.key); else shortcuts.resetBinding(row.key);
                  stopCapture();
                }}><i class="ph ph-arrow-counter-clockwise"></i></button>`
              : ""}
          </div>
        </div>`;
    };

    render(html`
      <div class="shortcut-group-header">Global</div>
      ${globalRows.map(rowTpl)}
      <div class="shortcut-group-header">Chats</div>
      ${chatsRows.map(rowTpl)}
    `, container);
  };

  function startCapture(row: Row): void {
    stopCapture();
    s.capturingKey = row.key;
    s.conflictMsg = null;

    const listener = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") { stopCapture(); return; }

      const combo = normalizeEvent(e);
      if (!combo) return;

      if (row.range) {
        const res = shortcuts.setRangeFromCombo(row.key, combo);
        if (!res.ok) {
          s.conflictMsg = res.conflict
            ? `Already used by: ${conflictLabel(res.conflict)}`
            : "Hold at least one modifier key (Ctrl, Shift or Alt)";
          re();
          return;
        }
      } else {
        const conflict = shortcuts.findConflict(combo, row.key);
        if (conflict) {
          s.conflictMsg = `Already used by: ${conflictLabel(conflict)}`;
          re();
          return;
        }
        shortcuts.setBinding(row.key, combo);
      }
      stopCapture();
    };

    s.captureListener = listener;
    document.addEventListener("keydown", listener, true);
    re();
  }

  function stopCapture(): void {
    if (s.captureListener) {
      document.removeEventListener("keydown", s.captureListener, true);
      s.captureListener = null;
    }
    s.capturingKey = null;
    s.conflictMsg = null;
    re();
  }

  re();
  return () => stopCapture();
}

export async function renderShortcutsView(root: HTMLElement): Promise<() => void> {
  render(html`
    <div class="view view-settings-shortcuts">
      ${settingsHeader("Shortcuts")}
      <div class="view-body">
        <div class="kit-section">
          <div id="shortcuts-container"></div>
        </div>
      </div>
    </div>
  `, root);

  const container = root.querySelector<HTMLElement>("#shortcuts-container");
  const cleanup = container ? renderShortcutsList(container) : () => {};
  return () => cleanup();
}
