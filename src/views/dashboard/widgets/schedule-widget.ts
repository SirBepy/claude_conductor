// Global dashboard widget: the next few scheduled items, with a quiet "Open
// calendar" button that pops the standalone Schedule window. Reads the same
// `schedule_list` / `schedule_list_external` / `list_instances` commands the
// calendar view does; no daemon API of its own.

import { html, render } from "lit-html";
import { invoke } from "../../../shared/ipc";
import { listen } from "../../../shared/events";
import { openSchedule } from "../../../shared/open-schedule";
import type { ExternalScheduledJob, Instance, ScheduledItem } from "../../../types/ipc.generated";
import { upcomingRows, whenLabel, type UpcomingRow } from "./schedule-widget-logic";
import type { Widget } from "./types";
import "./schedule-widget.css";

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

/** `"error"` is a failed `schedule_list` read: not the same as an empty
 * calendar, so it must not claim "Nothing scheduled". */
function draw(root: HTMLElement, rows: UpcomingRow[] | null | "error"): void {
  const openBtn = html`
    <button type="button" class="sched-w-open" @click=${openSchedule}>
      Open calendar<i class="ph ph-arrow-square-out"></i>
    </button>
  `;
  if (rows === null) {
    render(html`<div class="sched-w loading">Loading schedule&hellip;</div>`, root);
    return;
  }
  if (rows === "error") {
    render(html`
      <div class="sched-w">
        <div class="v-empty">
          <i class="ph ph-warning-circle v-empty-icon"></i>
          <div class="v-empty-title">Couldn't load the schedule</div>
        </div>
        <div class="sched-w-foot">${openBtn}</div>
      </div>
    `, root);
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

/** Reads that only enrich the list (external jobs, chat titles) degrade to
 * empty on failure; `schedule_list` is the list itself, so its failure is
 * surfaced instead of being drawn as an authoritative empty calendar. */
function softRead<T>(cmd: string, fallback: T): Promise<T> {
  return invoke<T>(cmd).catch((err) => {
    console.error(`[schedule-widget] ${cmd} failed`, err);
    return fallback;
  });
}

async function load(root: HTMLElement, alive: () => boolean, mount: { painted: boolean }): Promise<void> {
  const [items, external, instances] = await Promise.all([
    invoke<ScheduledItem[]>("schedule_list").catch((err): null => {
      console.error("[schedule-widget] schedule_list failed", err);
      return null;
    }),
    softRead<ExternalScheduledJob[]>("schedule_list_external", []),
    softRead<Instance[]>("list_instances", []),
  ]);
  if (!alive()) return;
  if (items === null) {
    // A refresh that fails after rows were painted keeps those rows.
    if (!mount.painted) draw(root, "error");
    return;
  }
  const titles = new Map((instances || []).map((i) => [i.session_id, i.name || ""]));
  mount.painted = true;
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
    const mount = { painted: false };
    draw(root, null);
    void load(root, () => alive, mount);
    const unlisten = listen("scheduled-items-changed", () => void load(root, () => alive, mount));
    return () => {
      alive = false;
      void unlisten.then((u) => u());
    };
  },
};
