// Todo chart: per day, how many .claude/todos/ todos were created, how many
// were done, and how big the backlog was, as three lines on one axis with a
// 7d / 30d / All switch. The daemon reads the dates off the todo files
// (project_dashboard/todo_stats.rs); this file only slices and draws.
import { html, nothing, type TemplateResult } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import { card, hidden, type DashCtx } from "./dash-parts";
import type { TodoDay } from "../../../types/ipc.generated";

export type TodoRange = "7d" | "30d" | "all";

const RANGES: Array<{ id: TodoRange, label: string }> = [
  { id: "7d", label: "7d" }, { id: "30d", label: "30d" }, { id: "all", label: "All" },
];

// Open is the level the other two move, so it leads. The hues are fixed rather
// than theme colors: several themes' primary and secondary are near-identical
// and fail a colorblind separation check, and these three pass it in both
// modes (pd-dashboard.css holds the per-mode steps).
const SERIES = [
  { key: "open", label: "Open", color: "var(--pd-todo-open)" },
  { key: "created", label: "Created", color: "var(--pd-todo-created)" },
  { key: "done", label: "Done", color: "var(--pd-todo-done)" },
] as const;
type SeriesKey = typeof SERIES[number]["key"];

/** The days the range shows, oldest first. Pure, for tests. */
export function todoDays(days: TodoDay[], range: TodoRange): TodoDay[] {
  if (range === "all") return days;
  return days.slice(-(range === "7d" ? 7 : 30));
}

const W = 420, H = 170, ML = 32, MR = 52, MT = 10, MB = 26;
const PW = W - ML - MR, PH = H - MT - MB;

/** A round number at or above `n` for the top gridline, so ticks read cleanly. */
function niceMax(n: number): number {
  if (n <= 4) return 4;
  const step = 10 ** Math.floor(Math.log10(n));
  return Math.ceil(n / step) * step;
}

/** End labels sit beside each line's last point, pushed apart so none overlap. Pure, for tests. */
export function dodge(ys: number[], gap = 11): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k++) {
    if (order[k]!.y - order[k - 1]!.y < gap) order[k]!.y = order[k - 1]!.y + gap;
  }
  const out = new Array<number>(ys.length);
  for (const o of order) out[o.i] = o.y;
  return out;
}

function chartSvg(days: TodoDay[]): string {
  const max = niceMax(Math.max(1, ...days.flatMap((d) => [d.open, d.created, d.done])));
  const n = days.length;
  const x = (i: number): number => ML + (n === 1 ? PW / 2 : (i / (n - 1)) * PW);
  const y = (v: number): number => MT + (1 - v / max) * PH;
  const grid = [0, 0.5, 1].map((f) => {
    const gy = y(f * max).toFixed(1);
    return `<line x1="${ML}" x2="${W - MR}" y1="${gy}" y2="${gy}" stroke="var(--color-border)" stroke-width="1"/>
      <text x="${ML - 5}" y="${(+gy + 3.5).toFixed(1)}" text-anchor="end" fill="var(--sb-muted)" font-size="9" font-family="Fira Code,monospace">${Math.round(f * max)}</text>`;
  }).join("");
  // At most ~6 date labels, always including the newest day.
  const every = Math.max(1, Math.ceil(n / 6));
  const dates = days.map((d, i) => ((n - 1 - i) % every === 0
    ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" fill="var(--sb-muted)" font-size="9" font-family="DM Sans,system-ui">${d.date.slice(5)}</text>`
    : "")).join("");
  const lines = SERIES.map((s) => {
    const pts = days.map((d, i) => `${x(i).toFixed(1)},${y(d[s.key]).toFixed(1)}`).join(" ");
    return n === 1
      ? `<circle cx="${x(0).toFixed(1)}" cy="${y(days[0]![s.key]).toFixed(1)}" r="4" fill="${s.color}"/>`
      : `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }).join("");
  const last = days[n - 1]!;
  const labelYs = dodge(SERIES.map((s) => y(last[s.key])));
  const ends = SERIES.map((s, k) => `<text x="${(x(n - 1) + 6).toFixed(1)}" y="${(labelYs[k]! + 3.5).toFixed(1)}" fill="var(--color-text-muted)" font-size="9.5" font-family="DM Sans,system-ui">${s.label} ${last[s.key]}</text>`).join("");
  const dots = SERIES.map((s) => `<circle data-todo-dot="${s.key}" r="4" fill="${s.color}" stroke="var(--color-surface)" stroke-width="2" visibility="hidden"/>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible" data-todo-chart data-n="${n}">${grid}${dates}${lines}${ends}
    <line data-todo-cross y1="${MT}" y2="${MT + PH}" stroke="var(--color-text-muted)" stroke-width="1" stroke-dasharray="3,2" visibility="hidden"/>${dots}</svg>`;
}

/** Crosshair and tooltip for the day under the pointer. Moves existing nodes
 *  in place rather than repainting the dashboard on every mouse move. */
function hover(e: PointerEvent, days: TodoDay[]): void {
  const wrap = e.currentTarget as HTMLElement;
  const svg = wrap.querySelector<SVGSVGElement>("svg[data-todo-chart]");
  const tip = wrap.querySelector<HTMLElement>(".pd-todo-tip");
  if (!svg || !tip || !days.length) return;
  const box = svg.getBoundingClientRect();
  if (!box.width) return;
  const vx = ((e.clientX - box.left) / box.width) * W;
  const n = days.length;
  const i = n === 1 ? 0 : Math.min(n - 1, Math.max(0, Math.round(((vx - ML) / PW) * (n - 1))));
  const d = days[i]!;
  const max = niceMax(Math.max(1, ...days.flatMap((x) => [x.open, x.created, x.done])));
  const cx = ML + (n === 1 ? PW / 2 : (i / (n - 1)) * PW);
  const cross = svg.querySelector("[data-todo-cross]");
  cross?.setAttribute("x1", cx.toFixed(1));
  cross?.setAttribute("x2", cx.toFixed(1));
  cross?.setAttribute("visibility", "visible");
  for (const s of SERIES) {
    const dot = svg.querySelector(`[data-todo-dot="${s.key}"]`);
    dot?.setAttribute("cx", cx.toFixed(1));
    dot?.setAttribute("cy", (MT + (1 - d[s.key] / max) * PH).toFixed(1));
    dot?.setAttribute("visibility", "visible");
  }
  tip.replaceChildren();
  const head = document.createElement("div");
  head.className = "pd-todo-tip-date";
  head.textContent = d.date;
  tip.append(head);
  for (const s of SERIES) {
    const row = document.createElement("div");
    row.innerHTML = `<span class="pd-todo-sw" style="background:${s.color}"></span>`;
    row.append(`${s.label} ${d[s.key as SeriesKey]}`);
    tip.append(row);
  }
  tip.hidden = false;
  // Flip to the left of the crosshair past the middle, so it never leaves the card.
  const px = (cx / W) * box.width;
  const left = px > box.width / 2 ? px - tip.offsetWidth - 10 : px + 10;
  tip.style.left = `${Math.max(0, left)}px`;
}

function unhover(e: PointerEvent): void {
  const wrap = e.currentTarget as HTMLElement;
  wrap.querySelectorAll("[data-todo-cross], [data-todo-dot]").forEach((n) => n.setAttribute("visibility", "hidden"));
  const tip = wrap.querySelector<HTMLElement>(".pd-todo-tip");
  if (tip) tip.hidden = true;
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
  const trailing = html`<span class="pd-usage-ranges">${RANGES.map((r) => html`
      <button type="button" class="pd-rtab ${range === r.id ? "on" : ""}" data-pd-todo-range=${r.id} @click=${() => c.act.setTodoRange(r.id)}>${r.label}</button>`)}</span>`;
  const body = html`
    <div class="pd-usage-total">${available} available${stats.claimed_now ? html`, ${stats.claimed_now} claimed` : nothing} · ${created} created, ${done} done in this range</div>
    <div class="pd-todo-legend">${SERIES.map((s) => html`<span><span class="pd-todo-sw" style="background:${s.color}"></span>${s.label}</span>`)}</div>
    <div class="pd-todo-chart" @pointermove=${(e: PointerEvent) => hover(e, days)} @pointerleave=${unhover}>
      ${unsafeHTML(chartSvg(days))}<div class="pd-todo-tip" hidden></div>
    </div>`;
  return card("Todos", body, { id: "todo_chart", trailing });
}
