// Dashboard header "more options" kebab, migrated onto the shared ARIA kebab
// (src/shared/kebab-menu.ts, todo 204/P1-6) instead of the ARIA-less
// session-more-menu base. The add-widget submenu is flattened into this one
// menu ("Add: <name>" items), since wireKebabMenu only manages one popover.

import { escapeHtml } from "../../shared/escape-html";
import { getWidget } from "./widget-registry";
import type { DashboardWidgetEntry } from "./widget-registry";
import { wireKebabMenu, closeKebabMenu } from "../../shared/kebab-menu";

export interface DashMoreMenuDeps {
  isEditMode: () => boolean;
  onToggleEditMode: () => void;
  triggerRefresh: () => Promise<void>;
  getDashboardWidgets: () => DashboardWidgetEntry[];
  /** Marks the widget enabled, persists the layout, and re-renders the shell. */
  enableWidget: (id: string) => void;
}

let menuEl: HTMLElement | null = null;

// The menu is rebuilt from scratch on every open (not once at mount) because
// its content is state-dependent: the edit-mode label flips, and the
// add-widget rows shrink as widgets get added.
function buildMenuHtml(deps: DashMoreMenuDeps): string {
  const editMode = deps.isEditMode();
  const parts: string[] = [
    `<button class="menu-item" role="menuitem" data-act="toggle-edit">
      <i class="ph ph-sliders-horizontal"></i> ${editMode ? "Done editing" : "Edit dashboard"}
    </button>`,
    `<button class="menu-item" role="menuitem" data-act="refresh">
      <i class="ph ph-arrows-clockwise"></i> Refresh now
    </button>`,
  ];

  const addable = deps.getDashboardWidgets().filter((e) => !e.enabled && getWidget(e.id));
  if (addable.length > 0) {
    parts.push(`<div class="menu-sep"></div>`);
    for (const entry of addable) {
      const widget = getWidget(entry.id)!;
      parts.push(`<button class="menu-item" role="menuitem" data-act="add-widget" data-widget-id="${escapeHtml(entry.id)}">
        <i class="ph ${escapeHtml(widget.icon)}"></i> Add: ${escapeHtml(widget.title)}
      </button>`);
    }
  }
  return parts.join("");
}

function wireMenuItems(menu: HTMLElement, deps: DashMoreMenuDeps): void {
  menu.querySelectorAll<HTMLButtonElement>(".menu-item").forEach((btn) => {
    btn.onclick = () => {
      closeKebabMenu(menu);
      const act = btn.dataset["act"];
      if (act === "toggle-edit") deps.onToggleEditMode();
      else if (act === "refresh") void deps.triggerRefresh();
      else if (act === "add-widget") {
        const id = btn.dataset["widgetId"];
        if (id) deps.enableWidget(id);
      }
    };
  });
}

/** Wires the dashboard header's `#dashMoreBtn`/`#dashMoreMenu` pair (markup
 * lives in dashboard.ts's template). Returns a dispose fn for view teardown. */
export function wireDashMoreMenu(root: HTMLElement, deps: DashMoreMenuDeps): () => void {
  const btn = root.querySelector<HTMLButtonElement>("#dashMoreBtn");
  const menu = root.querySelector<HTMLElement>("#dashMoreMenu");
  if (!btn || !menu) return () => { /* markup not mounted */ };

  menuEl = menu;
  const rebuild = () => {
    menu.innerHTML = buildMenuHtml(deps);
    wireMenuItems(menu, deps);
  };
  // Populate before first open too, and re-populate on every subsequent
  // click - registered before wireKebabMenu's own `onclick` below, so it
  // always runs first within the same toggle.
  rebuild();
  btn.addEventListener("click", rebuild);
  const disposeKebab = wireKebabMenu(btn, menu);

  return () => {
    btn.removeEventListener("click", rebuild);
    disposeKebab();
    if (menuEl === menu) menuEl = null;
  };
}

export function closeDashMenu(): void {
  if (menuEl) closeKebabMenu(menuEl);
}
