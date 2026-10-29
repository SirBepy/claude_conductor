// Todo chart: per day, how many .claude/todos/ todos were created, how many
// were done, and how big the backlog was, as three lines on one axis with a
// 7d / 30d / All switch. The daemon reads the dates off the todo files
// (project_dashboard/todo_stats.rs); this file only slices, and
// dash-line-chart.ts draws.
import { html, nothing, type TemplateResult } from "lit-html";
import { card, hidden, rangeTabs, type DashCtx, type DashRange } from "./dash-parts";
import { lineChart, type LineSeries } from "./dash-line-chart";
import type { TodoDay } from "../../../types/ipc.generated";

// Open is the number that matters, so it is the one line in color, drawn
// thicker and over a faint fill. Created and done are context: both thin and
// muted, told apart by solid vs dashed rather than by hue.
const SERIES: readonly LineSeries[] = [
  { key: "open", label: "Open", color: "var(--color-primary)", width: 2.25, dash: "", lead: true, endLabel: true },
  { key: "created", label: "Created", color: "var(--color-text-muted)", width: 1.25, dash: "" },
  { key: "done", label: "Done", color: "var(--color-text-muted)", width: 1.25, dash: "3 3" },
];

/** The days the range shows, oldest first. Pure, for tests. */
export function todoDays(days: TodoDay[], range: DashRange): TodoDay[] {
  if (range === "all") return days;
  return days.slice(-(range === "7d" ? 7 : 30));
}

export function todoChart(c: DashCtx): TemplateResult | typeof nothing {
  const stats = c.snap.todo_stats;
  // A project with no .claude/todos/ folder has nothing to chart.
  if (hidden(c, "todo_chart") || !stats?.days.length) return nothing;
  const range = c.todoRange ?? "30d";
  const days = todoDays(stats.days, range);
  const created = days.reduce((s, d) => s + d.created, 0);
  const done = days.reduce((s, d) => s + d.done, 0);
  const available = stats.open_now - stats.claimed_now;
  const trailing = rangeTabs(range, c.act.setTodoRange);
  const body = html`
    <div class="pd-usage-total">${available} available${stats.claimed_now ? html`, ${stats.claimed_now} claimed` : nothing} · ${created} created, ${done} done in this range</div>
    ${lineChart({ series: SERIES, rows: days, format: String, integer: true, floor: 4, legend: true })}`;
  return card("Todos", body, { id: "todo_chart", trailing });
}
