// Dashboard and Schedule as a panel beside the chat (Joe, 2026-11-02), instead
// of a full-screen view. Only the Chats window does this: it is the app's one
// desktop window, and its split (views/sessions/split-panels/) is the home for
// side panels. The phone and the pop-out windows keep the router views.
//
// This module is only the shared state: which screen is open and who is
// listening. It is not persisted on purpose: the panel is a "look at this now"
// surface, and a restart lands on the chat alone. The split owns the DOM, the
// router (router.ts / navigation.ts) owns the redirect into here.

import { isChatsWindow } from "./window-roles";

export type GlobalPanelView = "dashboard" | "schedule";

export const GLOBAL_PANEL_META: Record<GlobalPanelView, { label: string; icon: string }> = {
  dashboard: { label: "Dashboard", icon: "ph-squares-four" },
  schedule: { label: "Schedule", icon: "ph-alarm" },
};

/** The kit pane windows' DEFAULT_COMPACT_QUERY, copied rather than imported so the
 *  router chain stays free of the kit's window manager. */
const COMPACT_QUERY = "(max-width: 768px)";

let open: GlobalPanelView | null = null;
let hosts = 0;
const listeners = new Set<() => void>();

export function getGlobalPanel(): GlobalPanelView | null {
  return open;
}

export function setGlobalPanel(view: GlobalPanelView | null): void {
  if (view === open) return;
  open = view;
  for (const fn of [...listeners]) fn();
}

/** The split subscribes for as long as it is mounted. */
export function onGlobalPanelChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** A split that can show the panel is mounted. Counted rather than flagged:
 *  the new chat view mounts its split before the old one is destroyed. */
export function registerPanelHost(): () => void {
  hosts++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    hosts--;
  };
}

/** Whether a route into `view` lands in the panel. A window narrow enough that
 *  the chat view mounts the phone-style pane windows has no split to show it
 *  in, so it keeps the full-screen view; once a split is mounted it always
 *  wins, even if the window is later dragged narrow (fab-dial.ts's rule too). */
export function opensInGlobalPanel(view: string): view is GlobalPanelView {
  if (view !== "dashboard" && view !== "schedule") return false;
  if (!isChatsWindow()) return false;
  if (hosts > 0) return true;
  return !(typeof window.matchMedia === "function" && window.matchMedia(COMPACT_QUERY).matches);
}
