// Machine-picker chip row for the new-chat project picker (multi-machine
// federation). Copies account-field.ts's chip pattern (render + attach split,
// state owned by the caller) - project-picker.ts is the only caller; it
// re-renders via lit-html, so click handlers are re-attached to the fresh
// chip nodes after every render (see attachMachineFieldHandlers below).

import { escapeHtml } from "../../shared/escape-html";
import { attachChipKeyboardActivation } from "../../shared/account-chip";
import type { SelfMachine, PeerMachineView } from "../../shared/api";
import "../../shared/account-chip.css";

/** `null` = this machine - the default every time the picker opens (multi-
 * machine federation: new chats default local, per-open only, no persistence). */
export interface MachineFieldState {
  machineId: string | null;
}

export interface MachineFieldContext {
  self: SelfMachine | null;
  peers: PeerMachineView[];
}

function machineChipHtml(
  label: string,
  machineId: string,
  selected: boolean,
  offline: boolean,
): string {
  const cls = `account-chip machine-chip${selected ? " sel" : ""}${offline ? " machine-chip--offline" : ""}`;
  const tip = offline ? ` data-tip="${escapeHtml(label)} is offline"` : "";
  const stateAttrs = offline ? ` aria-disabled="true"` : ` role="button" tabindex="0"`;
  return `<span class="${cls}" data-machine-id="${escapeHtml(machineId)}"${stateAttrs}${tip}>${escapeHtml(label)}</span>`;
}

/** "" when there are no peers - the whole chip row is skipped for a
 * single-machine setup (H4: only render once list_machines() returns >=1 peer). */
export function renderMachineFieldHtml(state: MachineFieldState, ctx: MachineFieldContext): string {
  if (ctx.peers.length === 0) return "";
  const selfLabel = ctx.self?.label || "This machine";
  const chips = [
    machineChipHtml(selfLabel, "", state.machineId === null, false),
    ...ctx.peers.map((p) =>
      machineChipHtml(p.label, p.machine_id, state.machineId === p.machine_id, p.reach === "none"),
    ),
  ].join("");
  return `
    <div class="machine-field">
      <label class="machine-field-label">Machine</label>
      <div class="machine-field-chips">${chips}</div>
    </div>
  `;
}

// Containers already wired for delegated Enter/Space activation - `overlay`
// is project-picker.ts's modal host, which outlives every re-render (and,
// since ensureModalHost() is a session-lifetime singleton, every future
// picker open too), so attachChipKeyboardActivation must bind at most once
// per container rather than once per attachMachineFieldHandlers() call.
const chipKeyboardBound = new WeakSet<HTMLElement>();

/**
 * Wire up the machine-field's DOM handlers after `renderMachineFieldHtml`'s
 * output is in the overlay. Called after EVERY render (the chip markup is
 * re-created each time via lit-html's unsafeHTML, so old click listeners
 * already went with the old nodes) - mutates `state` and invokes `onChange`
 * with the newly picked id (null for "this machine"); the caller re-renders.
 */
export function attachMachineFieldHandlers(
  overlay: HTMLElement,
  state: MachineFieldState,
  onChange: (machineId: string | null) => void,
): void {
  overlay.querySelectorAll<HTMLElement>(".machine-field-chips .machine-chip").forEach((chip) => {
    if (chip.getAttribute("aria-disabled") === "true") return;
    chip.addEventListener("click", () => {
      const id = chip.dataset.machineId || null;
      if (state.machineId === id) return;
      state.machineId = id;
      onChange(id);
    });
  });
  if (!chipKeyboardBound.has(overlay)) {
    chipKeyboardBound.add(overlay);
    attachChipKeyboardActivation(overlay);
  }
}
