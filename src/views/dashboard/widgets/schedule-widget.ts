// Global dashboard widget: the next few scheduled items, with a quiet "Open
// calendar" button that pops the standalone Schedule window. Reads the same
// `schedule_list` / `schedule_list_external` / `list_instances` commands the
// calendar view does; no daemon API of its own.

import { html, render } from "lit-html";
import { invoke } from "../../../shared/ipc";
import { listen } from "../../../shared/events";
import { showView } from "../../../shared/navigation";
import type { ExternalScheduledJob, Instance, ScheduledItem } from "../../../types/ipc.generated";
import { upcomingRows, whenLabel, type UpcomingRow } from "./schedule-widget-logic";
import type { Widget } from "./types";
import "./schedule-widget.css";

/** The calendar lives in its own window on desktop. The browser/remote build
 * has no separate-window concept, so it routes in-place instead (same split as
 * the sidemenu's Schedule entry in main.ts). */
export function openFullSchedule(): void {
  if (window.__TAURI__) {
    void invoke("open_schedule_window").catch((err) =>
      console.error("[dashboard] open_schedule_window failed", err),
    );
    return;
  }
  showView("schedule");
}

function rowTemplate(r: UpcomingRow, now: Date) {
  return html`
    <li class="sched-w-row ${r.firing ? "is-firing" : ""}" data-sched-id=${r.id}>
      <i class="ph ${r.icon} sched-w-icon"></i>
      <span class="sched-w-label">${r.label}</span>
      ${r.recurring ? html`<i class="ph ph-repeat sched-w-repeat" title="Repeats"></i>` : ""}
      <span class="sched-w-when">${r.firing ? "Firing" : whenLabel(r.whenMs, now)}</span>
    </li>
  `;
}

function draw(root: HTMLElement, rows: UpcomingRow[] | null): void {
  const openBtn = html`
    <button type="button" class="sched-w-open" @click=${openFullSchedule}>
      Open calendar<i class="ph ph-arrow-square-out"></i>
    </button>
  `;
  if (rows === null) {
    render(html`<div class="sched-w loading">Loading schedule&hellip;</div>`, root);
    return;
  }
  if (rows.length === 0) {
    render(html`
      <div class="sched-w">
        <div class="v-empty">
          <i class="ph ph-calendar-dots v-empty-icon"></i>
          <div class="v-empty-title">Nothing scheduled</div>
        </div>
        <div class="sched-w-foot">${openBtn}</div>
      </div>
    `, root);
    return;
  }
  const now = new Date();
  render(html`
    <div class="sched-w">
      <ul class="sched-w-list">${rows.map((r) => rowTemplate(r, now))}</ul>
      <div class="sched-w-foot">${openBtn}</div>
    </div>
  `, root);
}

async function load(root: HTMLElement, alive: () => boolean): Promise<void> {
  const [items, external, instances] = await Promise.all([
    invoke<ScheduledItem[]>("schedule_list").catch(() => [] as ScheduledItem[]),
    invoke<ExternalScheduledJob[]>("schedule_list_external").catch(() => [] as ExternalScheduledJob[]),
    invoke<Instance[]>("list_instances").catch(() => [] as Instance[]),
  ]);
  if (!alive()) return;
  const titles = new Map((instances || []).map((i) => [i.session_id, i.name || ""]));
  draw(root, upcomingRows(items || [], external || [], titles));
}

export const scheduleWidget: Widget = {
  id: "schedule",
  title: "Schedule",
  icon: "ph-calendar-dots",
  scope: "global",
  dataDeps: ["scheduledItems"],
  render: (root) => {
    // A re-render replaces the body's content; a late reply from this mount
    // must not paint over it.
    let alive = true;
    draw(root, null);
    void load(root, () => alive);
    const unlisten = listen("scheduled-items-changed", () => void load(root, () => alive));
    return () => {
      alive = false;
      void unlisten.then((u) => u());
    };
  },
};
