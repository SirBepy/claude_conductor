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

// Open is the number that matters, so it is the one line in color, drawn
// thicker and over a faint fill. Created and done are context: both thin and
// muted, told apart by solid vs dashed rather than by hue.
const SERIES = [
  { key: "open", label: "Open", color: "var(--color-primary)", width: 2.25, dash: "" },
  { key: "created", label: "Created", color: "var(--color-text-muted)", width: 1.25, dash: "" },
  { key: "done", label: "Done", color: "var(--color-text-muted)", width: 1.25, dash: "3 3" },
] as const;
type Series = typeof SERIES[number];

/** The days the range shows, oldest first. Pure, for tests. */
export function todoDays(days: TodoDay[], range: TodoRange): TodoDay[] {
  if (range === "all") return days;
  return days.slice(-(range === "7d" ? 7 : 30));
}

const W = 420, H = 160, ML = 28, MR = 44, MT = 10, MB = 24;
const PW = W - ML - MR, PH = H - MT - MB;

/** The y-axis: a round step (1, 2 or 5 times a power of ten) that splits the
 *  range into at most four bands, and the gridline at or above `max`, so the
 *  gridlines land on round numbers (0 / 20 / 40 / 60) instead of halves of an
 *  arbitrary top. Never below 4, so a near-empty week still gets a few lines.
 *  Pure, for tests. */
export function niceScale(max: number): { top: number, step: number } {
  const rough = Math.max(4, max) / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((k) => k * pow).find((s) => s >= rough)!;
  return { top: Math.ceil(Math.max(4, max) / step) * step, step };
}

const peak = (days: TodoDay[]): number => Math.max(1, ...days.flatMap((d) => [d.open, d.created, d.done]));

/** An SVG path through the points as a monotone cubic curve (Fritsch-Carlson):
 *  smooth bends instead of sharp corners, and it never swings above or below
 *  the data between two days, so a count never reads as higher than it was.
 *  Pure, for tests. */
export function smoothPath(pts: Array<[number, number]>): string {
  const n = pts.length;
  if (n === 0) return "";
  const f = (v: number): string => v.toFixed(1);
  if (n === 1) return `M${f(pts[0]![0])},${f(pts[0]![1])}`;
  const dx = pts.slice(1).map((p, i) => p[0] - pts[i]![0]);
  const slope = pts.slice(1).map((p, i) => (p[1] - pts[i]![1]) / dx[i]!);
  const m = pts.map((_, i) => {
    if (i === 0) return slope[0]!;
    if (i === n - 1) return slope[n - 2]!;
    const a = slope[i - 1]!, b = slope[i]!;
    // A peak or valley (or a flat side) gets a flat tangent, which is what keeps the curve monotone.
    return a * b <= 0 ? 0 : (2 * a * b) / (a + b);
  });
  let d = `M${f(pts[0]![0])},${f(pts[0]![1])}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i]!, [x1, y1] = pts[i + 1]!;
    const h = dx[i]! / 3;
    d += ` C${f(x0 + h)},${f(y0 + m[i]! * h)} ${f(x1 - h)},${f(y1 - m[i + 1]! * h)} ${f(x1)},${f(y1)}`;
  }
  return d;
}

/** A short line sample for the legend and tooltip, styled like its series. */
function swatch(s: Series): string {
  return `<svg class="pd-todo-sw" viewBox="0 0 14 4" width="14" height="4"><line x1="1" x2="13" y1="2" y2="2" stroke="${s.color}" stroke-width="${Math.max(1.5, s.width)}" stroke-linecap="round"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}/></svg>`;
}

function chartSvg(days: TodoDay[]): string {
  const { top: max, step } = niceScale(peak(days));
  const n = days.length;
  const x = (i: number): number => ML + (n === 1 ? PW / 2 : (i / (n - 1)) * PW);
  const y = (v: number): number => MT + (1 - v / max) * PH;
  const base = MT + PH;
  const grid = Array.from({ length: max / step + 1 }, (_, k) => {
    const gy = y(k * step).toFixed(1);
    return `<line x1="${ML}" x2="${W - MR}" y1="${gy}" y2="${gy}" stroke="var(--color-border)" stroke-width="1" opacity="0.6"/>
      <text x="${ML - 6}" y="${(+gy + 3).toFixed(1)}" text-anchor="end" fill="var(--sb-muted)" font-size="8.5" font-family="Fira Code,monospace">${k * step}</text>`;
  }).join("");
  // At most ~5 date labels, always including the newest day.
  const every = Math.max(1, Math.ceil(n / 5));
  const dates = days.map((d, i) => ((n - 1 - i) % every === 0
    ? `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" fill="var(--sb-muted)" font-size="8.5" font-family="DM Sans,system-ui">${d.date.slice(5)}</text>`
    : "")).join("");
  // Context lines first, so the open line is drawn over them.
  const lines = [...SERIES].reverse().map((s) => {
    if (n === 1) return `<circle data-todo-line="${s.key}" cx="${x(0).toFixed(1)}" cy="${y(days[0]![s.key]).toFixed(1)}" r="3.5" fill="${s.color}"/>`;
    const path = smoothPath(days.map((d, i) => [x(i), y(d[s.key])]));
    const fill = s.key === "open"
      ? `<path d="${path} L${x(n - 1).toFixed(1)},${base} L${x(0).toFixed(1)},${base} Z" fill="${s.color}" opacity="0.08"/>`
      : "";
    return `${fill}<path data-todo-line="${s.key}" d="${path}" fill="none" stroke="${s.color}" stroke-width="${s.width}" stroke-linecap="round"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}${s.key === "open" ? "" : ` opacity="0.7"`}/>`;
  }).join("");
  // Only the open line is labelled at its end; the legend names the other two.
  const last = days[n - 1]!;
  const end = `<text x="${(x(n - 1) + 6).toFixed(1)}" y="${(y(last.open) + 3.5).toFixed(1)}" fill="var(--color-text)" font-size="10" font-weight="600" font-family="DM Sans,system-ui">${last.open}</text>`;
  const dots = SERIES.map((s) => `<circle data-todo-dot="${s.key}" r="${s.key === "open" ? 3.5 : 2.5}" fill="${s.color}" stroke="var(--color-surface)" stroke-width="1.5" visibility="hidden"/>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible" data-todo-chart data-n="${n}">${grid}${dates}${lines}${end}
    <line data-todo-cross y1="${MT}" y2="${base}" stroke="var(--color-border)" stroke-width="1" visibility="hidden"/>${dots}</svg>`;
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
  const max = niceScale(peak(days)).top;
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
    row.innerHTML = swatch(s);
    row.append(`${s.label} ${d[s.key]}`);
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
    <div class="pd-todo-legend">${SERIES.map((s) => html`<span>${unsafeHTML(swatch(s))}${s.label}</span>`)}</div>
    <div class="pd-todo-chart" @pointermove=${(e: PointerEvent) => hover(e, days)} @pointerleave=${unhover}>
      ${unsafeHTML(chartSvg(days))}<div class="pd-todo-tip" hidden></div>
    </div>`;
  return card("Todos", body, { id: "todo_chart", trailing });
}
