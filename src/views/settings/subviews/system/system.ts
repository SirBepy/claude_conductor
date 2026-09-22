import { html, render } from "lit-html";
import { saveSettings } from "../../../../shared/settings-save";
import { getSettings } from "../../../../shared/state";
import { api } from "../../../../shared/api";
import * as shortcuts from "../../../../shared/shortcuts";
import { normalizeEvent } from "../../../../shared/shortcuts";
import type { ShortcutDef } from "../../../../shared/shortcuts";
import type { DatasetInfo, DatasetId, RetentionPolicy } from "../../../../types/ipc.generated";
import { askConfirm } from "../../../../shared/confirm";
import { settingsHeader, toggleRow, selectHtml, escapeHtml } from "../../ui";
import "./system.css";

// ── Shortcuts (ported from subviews/shortcuts/shortcuts.ts) ───────────────

interface ShortcutsUIState {
  capturingId: string | null;
  conflictMsg: string | null;
  captureListener: ((e: KeyboardEvent) => void) | null;
}

function renderShortcutsSection(container: HTMLElement): () => void {
  const s: ShortcutsUIState = { capturingId: null, conflictMsg: null, captureListener: null };

  const re = () => {
    const defs = shortcuts.getAll();
    const globalDefs = defs.filter(d => !d.context && !d.todo);
    const chatsDefs = defs.filter(d => d.context === "sessions" && !d.todo && !d.id.startsWith("assign-slot-"));
    const assignDefs = defs.filter(d => d.id.startsWith("assign-slot-") && !d.todo);
    const todoDefs = defs.filter(d => !!d.todo);
    const slotMode = shortcuts.getChatSlotMode();
    const isManual = slotMode === "manual";

    function kbdHtml(id: string): string {
      const binding = shortcuts.getBinding(id);
      return binding.split("+").map(k =>
        `<kbd>${k.charAt(0).toUpperCase() + k.slice(1)}</kbd>`
      ).join("+");
    }

    function rowHtml(def: ShortcutDef): string {
      const isCapturing = s.capturingId === def.id;
      const hasOverride = shortcuts.hasOverride(def.id);
      const isTodo = !!def.todo;

      const bindingEl = isCapturing
        ? `<span class="shortcut-capture-input">Press a key combo...</span>`
        : `<span class="shortcut-kbd">${kbdHtml(def.id)}</span>`;

      const conflictEl = (isCapturing && s.conflictMsg)
        ? `<div class="shortcut-conflict-msg">${s.conflictMsg}</div>`
        : "";

      const controls = isTodo
        ? `<span class="shortcut-row-todo-tag">coming soon</span>`
        : `<div class="shortcut-row-controls">
            <div>
              ${bindingEl}
              ${conflictEl}
            </div>
            <button class="shortcut-rebind-btn" data-rebind="${def.id}">${isCapturing ? "Cancel" : "Rebind"}</button>
            ${hasOverride ? `<button class="shortcut-reset-btn" data-reset="${def.id}" title="Reset to default"><i class="ph ph-arrow-counter-clockwise"></i></button>` : ""}
          </div>`;

      return `<div class="shortcut-row${isTodo ? " is-todo" : ""}" data-id="${def.id}">
        <div class="shortcut-row-info">
          <span class="shortcut-row-label">${def.label}</span>
          <span class="shortcut-row-desc">${def.description}</span>
        </div>
        ${controls}
      </div>`;
    }

    container.innerHTML = `
      <div class="shortcut-group-header">Global</div>
      ${globalDefs.map(rowHtml).join("")}
      <div class="shortcut-group-header">Chats</div>
      ${chatsDefs.map(rowHtml).join("")}
      <div id="slot-mode-row"></div>
      <div class="shortcut-slot-mode-desc-standalone">${isManual
        ? "Ctrl+Shift+1-9 pins a chat to a slot. Ctrl+1-9 opens the pinned chat."
        : "Ctrl+1-9 opens chats by their sorted position."
      }</div>
      ${isManual ? `<div class="shortcut-group-header shortcut-group-header--sub">Slot assignment keys</div>${assignDefs.map(rowHtml).join("")}` : ""}
      <div class="shortcut-group-header">Coming Soon</div>
      ${todoDefs.map(rowHtml).join("")}
    `;

    // Slot-mode toggle is a shared kit-toggle (ui.ts), rendered via lit-html
    // into its own placeholder - the rest of this section stays a plain
    // innerHTML string rebuild, same as the ported original.
    const slotModeRow = container.querySelector<HTMLElement>("#slot-mode-row");
    if (slotModeRow) {
      render(
        toggleRow({
          label: "Manual slot assignment",
          inputId: "slot-mode-checkbox",
          checked: isManual,
          onChange: (e: Event) => {
            const checked = (e.target as HTMLInputElement).checked;
            shortcuts.setChatSlotMode(checked ? "manual" : "auto");
            re();
          },
        }),
        slotModeRow,
      );
    }

    container.querySelectorAll<HTMLButtonElement>("[data-rebind]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.rebind!;
        if (s.capturingId === id) {
          stopCapture();
        } else {
          startCapture(id);
        }
      });
    });

    container.querySelectorAll<HTMLButtonElement>("[data-reset]").forEach(btn => {
      btn.addEventListener("click", () => {
        shortcuts.resetBinding(btn.dataset.reset!);
        stopCapture();
      });
    });
  };

  function startCapture(id: string): void {
    stopCapture();
    s.capturingId = id;
    s.conflictMsg = null;

    const listener = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") { stopCapture(); return; }

      const combo = normalizeEvent(e);
      if (!combo) return;

      const conflict = shortcuts.findConflict(combo, id);
      if (conflict) {
        s.conflictMsg = `Already used by: ${conflict.label}`;
        re();
        return;
      }

      shortcuts.setBinding(id, combo);
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
    s.capturingId = null;
    s.conflictMsg = null;
    re();
  }

  re();
  return () => stopCapture();
}

// ── Data & storage (ported from settings.ts root Data section) ────────────

const RETENTION_OPTIONS: { value: RetentionPolicy; label: string }[] = [
  { value: "forever", label: "Never" },
  { value: "365d", label: "1 year" },
  { value: "90d", label: "90 days" },
  { value: "30d", label: "30 days" },
  { value: "7d", label: "7 days" },
];

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// "52340" -> "52,340". record_count arrives as bigint (unix-second counts can
// exceed safe-int territory only in theory, but bigint formats fine via String).
function formatCount(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// unix SECONDS (bigint) -> "Mon YYYY". Multiply into ms as a Number; even far-
// future second values stay well within Number's safe range.
function formatMonthYear(unixSeconds: bigint): string {
  const d = new Date(Number(unixSeconds) * 1000);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function formatBytes(bytes: bigint): string {
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

function datasetSubline(info: DatasetInfo): string {
  if (info.record_count === BigInt(0) || info.oldest_entry === null || info.newest_entry === null) {
    return "No data yet";
  }
  const range = `${formatMonthYear(info.oldest_entry)} - ${formatMonthYear(info.newest_entry)}`;
  return `${formatCount(info.record_count)} records · ${range}`;
}

function dataCardHtml(info: DatasetInfo): string {
  const select = selectHtml({
    className: "data-retention",
    dataset: { dataset: info.dataset },
    options: RETENTION_OPTIONS,
    selected: info.retention,
  });
  return `
    <div class="kit-section data-card">
      <div class="data-card-head">
        <span class="kit-row-label">${escapeHtml(info.label)}</span>
        <span class="data-card-sub">${escapeHtml(datasetSubline(info))}</span>
      </div>
      <div class="kit-row data-card-controls">
        <span class="kit-row-label data-control-label">Keep for</span>
        <div class="data-control-actions">
          ${select}
          <button class="btn-danger data-clear" data-dataset="${info.dataset}">Clear all</button>
        </div>
      </div>
    </div>`;
}

let dataWired = false;

async function refreshDataSection(): Promise<void> {
  const cards = document.getElementById("dataCards");
  const totalEl = document.getElementById("dataTotal");
  if (!cards || !totalEl) return;

  const infos = await api.getStorageInfo();
  cards.innerHTML = infos.map(dataCardHtml).join("");

  // total_db_bytes is identical on every entry; read it once.
  const first = infos[0];
  if (first) {
    totalEl.textContent = `Total: ${formatBytes(first.total_db_bytes)}`;
    totalEl.style.display = "";
  } else {
    totalEl.style.display = "none";
  }

  // Delegated listeners bound once to the stable container, so re-rendering the
  // innerHTML on refresh doesn't accumulate handlers.
  if (!dataWired) {
    dataWired = true;
    cards.addEventListener("change", (e) => {
      const sel = (e.target as HTMLElement)?.closest<HTMLSelectElement>("select.data-retention");
      if (!sel) return;
      const dataset = sel.dataset.dataset as DatasetId | undefined;
      if (!dataset) return;
      const policy = sel.value as RetentionPolicy;
      void (async () => {
        try {
          await api.setRetentionPolicy(dataset, policy);
          await refreshDataSection();
        } catch (err) {
          console.error("[settings-system data] set retention failed", err);
        }
      })();
    });
    cards.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement)?.closest<HTMLButtonElement>("button.data-clear");
      if (!btn) return;
      const dataset = btn.dataset.dataset as DatasetId | undefined;
      if (!dataset) return;
      const label = btn.closest(".data-card")?.querySelector(".kit-row-label")?.textContent ?? dataset;
      void (async () => {
        if (!(await askConfirm(`Clear all ${label} data?`, { confirmLabel: "Clear" }))) return;
        try {
          await api.clearDataset(dataset);
          await refreshDataSection();
        } catch (err) {
          console.error("[settings-system data] clear dataset failed", err);
        }
      })();
    });
  }
}

// ── View ────────────────────────────────────────────────────────────────

export async function renderSystemView(root: HTMLElement): Promise<() => void> {
  render(template(!!getSettings().autostart), root);

  const launchAtLogin = root.querySelector<HTMLInputElement>("#launchAtLogin");
  if (launchAtLogin) launchAtLogin.addEventListener("change", saveSettings);

  const shortcutsContainer = root.querySelector<HTMLElement>("#system-shortcuts-container");
  const cleanupShortcuts = shortcutsContainer ? renderShortcutsSection(shortcutsContainer) : () => {};

  // Fresh container each render -> rebind the delegated Data listeners.
  dataWired = false;
  try { await refreshDataSection(); }
  catch (e) { console.error("[settings-system data] render failed", e); }

  return () => {
    cleanupShortcuts();
  };
}

function template(autostart: boolean) {
  return html`
    <div class="view view-settings-system">
      ${settingsHeader("System")}
      <div class="view-body">

        <div class="kit-section">
          <div class="kit-section-title">Startup</div>
          ${toggleRow({ label: "Launch at login", inputId: "launchAtLogin", checked: autostart })}
        </div>

        <div class="kit-section">
          <div class="kit-section-title">Shortcuts</div>
          <div id="system-shortcuts-container"></div>
        </div>

        <div class="kit-section" id="dataSection">
          <div class="kit-section-title">Data &amp; storage</div>
          <!-- Cards injected as a plain innerHTML string (NOT a lit .map):
               production lit-html silently drops repeated/nested templates
               containing a <select>. See project memory. -->
          <div id="dataCards" class="data-cards"></div>
          <div id="dataTotal" class="data-total"></div>
        </div>

      </div>
    </div>
  `;
}
