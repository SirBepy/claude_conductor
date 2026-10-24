/**
 * View-navigation helpers. Ported from the legacy src/dashboard.js + the stats
 * module helpers (openProjectDetail, openSessionDetail, openAllSessions,
 * showMergeModal).
 *
 * Every top-level view is migrated — the router owns DOM swapping. For the
 * remaining legacy `.view` divs in index.html (graph-detail, settings-sync)
 * we still toggle the `.hidden` class when the router isn't present.
 *
 * Each helper is also assigned to `window.<name>` at module bottom for
 * back-compat with any lingering legacy callers.
 */

import {
  getProjectDetailState,
  getProjectSubviewStack,
  setCurrentSessionRecord,
} from "./state";
import { updateSidemenuActive } from "./sidemenu";
import { askConfirm } from "./confirm";

const LEGACY_VIEWS = [
  "settings",
  "settings-notifications",
  "settings-permissions",
  "settings-sync",
  "project-detail",
  "graph-detail",
  "project-character-pick",
  "project-automation",
  "project-folder-mapping",
  "project-sessions",
  "session-detail",
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

export function backFromSubview(): void {
  const origin = getProjectSubviewStack().pop() || "project-detail";
  showView(origin);
}

export function openProjectSubview(subview: string): void {
  getProjectSubviewStack().push("project-detail");
  showView(subview);
}

export function openSessionDetailView(originView: string): void {
  getProjectSubviewStack().push(originView);
  showView("session-detail");
}

export function openProjectDetail(cwd: string): void {
  const state = getProjectDetailState();
  state.cwd = cwd;
  state.offset = 0;
  showView("project-detail");
}

export function openSessionDetail(record: unknown, originView?: string): void {
  if (!record) return;
  setCurrentSessionRecord(record);
  openSessionDetailView(originView || "project-detail");
}

export function openAllSessions(cwd: string): void {
  getProjectDetailState().cwd = cwd;
  openProjectSubview("project-sessions");
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
  backFromSubview?: typeof backFromSubview;
  openProjectSubview?: typeof openProjectSubview;
  openSessionDetailView?: typeof openSessionDetailView;
  openProjectDetail?: typeof openProjectDetail;
  openSessionDetail?: typeof openSessionDetail;
  openAllSessions?: typeof openAllSessions;
  showMergeModal?: typeof showMergeModal;
}
const w = window as unknown as NavWindow;
w.showView = showView;
w.backFromSubview = backFromSubview;
w.openProjectSubview = openProjectSubview;
w.openSessionDetailView = openSessionDetailView;
w.openProjectDetail = openProjectDetail;
w.openSessionDetail = openSessionDetail;
w.openAllSessions = openAllSessions;
w.showMergeModal = showMergeModal;
