// Every "open the calendar" entry point (sidemenu, Home schedule widget, the
// sessions "more" menu) shares this. The calendar lives in its own window on
// desktop; the browser/remote build has no separate-window concept, so it
// routes in-place instead. A failed open is logged, never thrown: the click
// handlers have nowhere to surface it.

import { invoke } from "./ipc";
import { showView } from "./navigation";

export function openSchedule(): void {
  if (window.__TAURI__) {
    void invoke("open_schedule_window").catch((err) =>
      console.error("[schedule] open_schedule_window failed", err),
    );
    return;
  }
  showView("schedule");
}
