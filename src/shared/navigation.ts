/**
 * View-navigation helpers. Ported from the legacy src/dashboard.js + the stats
 * module helpers (showMergeModal).
 *
 * Every top-level view is migrated — the router owns DOM swapping. For the
 * remaining legacy `.view` divs in index.html (graph-detail, settings-sync)
 * we still toggle the `.hidden` class when the router isn't present.
 *
 * Each helper is also assigned to `window.<name>` at module bottom for
 * back-compat with any lingering legacy callers.
 */

import { updateSidemenuActive } from "./sidemenu";
import { askConfirm } from "./confirm";

const LEGACY_VIEWS = [
  "settings",
  "settings-notifications",
  "settings-permissions",
  "settings-sync",
  "graph-detail",
];

interface RouterWindow {
  navigateTo?: (name: string) => void | Promise<void>;
}

function routerWin(): RouterWindow {
  return window as unknown as RouterWindow;
}

let activeView = "dashboard";

export function showView(name: string): void {
  activeView = name;
  const nav = routerWin().navigateTo;
  if (typeof nav === "function") {
    void nav(name);
  } else {
    for (const id of LEGACY_VIEWS) {
      const el = document.getElementById(`view-${id}`);
      if (el) el.classList.toggle("hidden", id !== name);
    }
  }
  updateSidemenuActive(name);
}

export function getActiveView(): string {
  return activeView;
}

export function setActiveView(name: string): void {
  activeView = name;
}

export function showMergeModal(
  text: string,
  onConfirm: () => void,
  onCancel?: () => void,
  confirmLabel?: string,
): void {
  void askConfirm(text, { confirmLabel, danger: false }).then((ok) => {
    if (ok) onConfirm();
    else if (onCancel) onCancel();
  });
}

// ── Back-compat window bindings ────────────────────────────────────────────
interface NavWindow {
  showView?: typeof showView;
  showMergeModal?: typeof showMergeModal;
}
const w = window as unknown as NavWindow;
w.showView = showView;
w.showMergeModal = showMergeModal;
