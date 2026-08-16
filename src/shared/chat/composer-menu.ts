// Small action menu popped from the composer's split-send chevron. Body-appended,
// position:fixed, anchored off the chevron - mirrors the openSchedulePicker
// popover idiom and reuses its popover/row styles so there's no new chrome.
import { openActionPopover } from "./anchored-popover";
import "./schedule-picker.css";

export interface ComposerMenuItem {
  /** Phosphor icon name without the `ph-` prefix. */
  icon: string;
  label: string;
  run: () => void;
}

export function openComposerMenu(anchor: HTMLElement, items: ComposerMenuItem[]): void {
  if (items.length === 0) return;

  const bodyHtml = `
    <div class="schedule-picker-rows">
      ${items
        .map(
          (it, i) => `
        <button type="button" class="schedule-picker-row" data-idx="${i}">
          <span class="schedule-picker-row-label"><i class="ph ph-${it.icon}"></i> ${it.label}</span>
        </button>`,
        )
        .join("")}
    </div>
  `;

  const popover = openActionPopover({
    anchor,
    className: "schedule-picker-popover composer-menu-popover",
    bodyHtml,
    buttonSelector: "[data-idx]",
    onPick: (btn) => {
      const item = items[Number(btn.dataset.idx)];
      popover.close();
      item?.run();
    },
  });
}
