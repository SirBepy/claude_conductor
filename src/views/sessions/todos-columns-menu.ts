// Columns menu for the Todos panel (todo 692), opened by the strip's eye button.
// PopoverShell, not an absolute div: the rail host CLIPS its children, and the
// shell body-appends a fixed element that escapes that. It deliberately STAYS
// OPEN while toggling, so several columns can be switched on in one visit.

import { PopoverShell } from "./statusbar-popover-shell";
import { OPTIONAL_COLUMNS } from "./todos-panel";
import "./todos-columns-menu.css";

export interface TodosColumnsMenuDeps {
  counts: Record<string, number>;
  isShown: (key: string) => boolean;
  onToggle: (key: string) => void;
  onClearArchived: () => void;
}

const LABEL: Record<string, string> = {
  project: "Project wide",
  done: "Done",
  archived: "Archived",
};

const shell = new PopoverShell();

function menuHtml(deps: TodosColumnsMenuDeps): string {
  // Locked eye rather than omitted: being in the list is how the derived-scope
  // model teaches itself without a tooltip.
  const here = `
    <div class="td-menu-row is-locked">
      <span class="td-menu-swatch td-swatch-here"></span>
      <span class="td-menu-nm">This chat</span>
      <span class="td-menu-n">${deps.counts.here ?? 0}</span>
      <i class="ph-fill ph-eye td-menu-eye"></i>
    </div>`;
  const rest = OPTIONAL_COLUMNS.map((key) => {
    const shown = deps.isShown(key);
    return `
    <button type="button" class="td-menu-row ${shown ? "is-shown" : "is-hidden"}" data-col="${key}">
      <span class="td-menu-swatch td-swatch-${key}"></span>
      <span class="td-menu-nm">${LABEL[key]}</span>
      <span class="td-menu-n">${deps.counts[key] ?? 0}</span>
      <i class="ph ${shown ? "ph-fill ph-eye" : "ph-eye-slash"} td-menu-eye"></i>
    </button>`;
  }).join("");
  return `
    <div class="td-menu-label">Columns</div>
    ${here}${rest}
    <div class="td-menu-sep"></div>
    <button type="button" class="td-menu-item" data-act="clear-archived">
      <i class="ph ph-broom"></i><span>Clear archived</span>
    </button>`;
}

export function closeTodosColumnsMenu(): void {
  shell.close();
}

export function openTodosColumnsMenu(anchor: HTMLElement, deps: TodosColumnsMenuDeps): void {
  if (shell.isOpen) {
    shell.close();
    return;
  }
  const rebuild = () => {
    shell.open(anchor, menuHtml(deps), { className: "td-columns-menu", wire });
  };
  const wire = (el: HTMLElement): void => {
    el.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const row = target.closest<HTMLElement>("[data-col]");
      if (row?.dataset.col) {
        deps.onToggle(row.dataset.col);
        // Rebuild in place so the eye and the count update without closing.
        rebuild();
        return;
      }
      if (target.closest<HTMLElement>('[data-act="clear-archived"]')) {
        deps.onClearArchived();
        rebuild();
      }
    });
  };
  rebuild();
}
