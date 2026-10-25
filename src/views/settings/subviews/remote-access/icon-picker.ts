// Icon picker for a machine row in Settings > Remote access: a button showing
// the machine's current glyph that opens an anchored grid of the icons the
// sidebar can already show (OS logos + the clash pool), plus "Automatic",
// which clears the choice so the OS-based assignment applies again.

import { openActionPopover, type ActionPopoverHandle } from "../../../../shared/chat/anchored-popover";
import { CLASH_POOL, OS_LOGO } from "../../../sessions/machine-icons";

/** Deduped so the grid never shows the same glyph twice. */
export const PICKER_ICONS: string[] = [...new Set([...Object.values(OS_LOGO), ...CLASH_POOL])];

let open: ActionPopoverHandle | null = null;

/** True while a grid is showing; the machines list skips re-rendering then,
 *  since a re-render would detach the button the grid is anchored to. */
export function isIconPickerOpen(): boolean {
  return open !== null;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** `shown` is the glyph on the button (chosen or automatic); `chosen` is only
 *  the explicit pick, so the grid can mark it (null = Automatic). */
export function iconButtonHtml(id: string, shown: string, chosen: string | null | undefined): string {
  return `<button type="button" class="ra-icon-btn" data-id="${esc(id)}" data-chosen="${esc(chosen ?? "")}" aria-label="Change icon" title="Change icon"><i class="ph ${esc(shown)}"></i></button>`;
}

function gridHtml(chosen: string): string {
  const auto = `<button type="button" class="ra-icon-auto${chosen ? "" : " active"}" data-icon="" aria-pressed="${chosen ? "false" : "true"}">Automatic</button>`;
  const cells = PICKER_ICONS.map((icon) =>
    `<button type="button" class="ra-icon-cell${icon === chosen ? " active" : ""}" data-icon="${esc(icon)}" aria-label="${esc(icon.replace(/^ph-/, "").replace(/-/g, " "))}" aria-pressed="${icon === chosen ? "true" : "false"}"><i class="ph ${esc(icon)}"></i></button>`,
  ).join("");
  return `${auto}<div class="ra-icon-grid">${cells}</div>`;
}

/** Wires every `.ra-icon-btn` under `listSelector`. `pick` gets the machine id
 *  and the chosen icon class, or null for Automatic. */
export function wireIconPickers(
  root: HTMLElement,
  listSelector: string,
  pick: (id: string, icon: string | null) => Promise<unknown>,
  errorLabel: string,
): void {
  root.querySelectorAll<HTMLButtonElement>(`${listSelector} .ra-icon-btn`).forEach((btn) => {
    btn.onclick = () => {
      if (open) { open.close(); return; }
      const id = btn.dataset.id ?? "";
      const handle = openActionPopover({
        anchor: btn,
        className: "ra-icon-pop",
        bodyHtml: gridHtml(btn.dataset.chosen ?? ""),
        buttonSelector: ".ra-icon-auto, .ra-icon-cell",
        onClose: () => { open = null; },
        onPick: (cell) => {
          const icon = cell.dataset.icon || null;
          handle.close();
          void pick(id, icon).catch((e) => console.error(`[remote-access] ${errorLabel} failed`, e));
        },
      });
      open = handle;
    };
  });
}
