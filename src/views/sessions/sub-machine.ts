// Where a sub runs, when it is not on this machine (cross-machine subchats): a
// quiet icon and the machine's name next to the sub, the same icon the sidebar rows
// show for that machine. A sub on this machine carries no `machine`, so it draws nothing.

import type { MachineRef } from "../../types/ipc.generated";
import { escapeHtml } from "../../shared/escape-html";
import { GENERIC_MACHINE_ICON, machineIcon } from "./machine-icons";

/** "on Mac mini", or "on Mac mini (offline)" when its link is down: the words a hover
 *  card or a title says. Empty for a sub on this machine. */
export function subMachineWords(machine: MachineRef | null | undefined): string {
  return machine ? `on ${machine.label}${machine.online === false ? " (offline)" : ""}` : "";
}

/** The chip in a sub's row: the machine's icon and its name. */
export function subMachineChipHtml(machine: MachineRef | null | undefined): string {
  if (!machine) return "";
  const icon = machineIcon(machine.id) ?? GENERIC_MACHINE_ICON;
  const off = machine.online === false;
  return `<span class="sub-machine${off ? " sub-machine--offline" : ""}" data-machine="${escapeHtml(machine.id)}" title="${escapeHtml(subMachineWords(machine))}"><i class="ph ${icon}" aria-hidden="true"></i>${escapeHtml(machine.label)}</span>`;
}
