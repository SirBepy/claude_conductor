// The dashboard's one line chart: a value per day for one or more series,
// smooth lines on a shared axis, two kinds of gridline, and a crosshair with a
// tooltip for the day under the pointer. The Todos and Usage cards both draw
// through here, so they read the same way.
import { html, nothing, type TemplateResult } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";

export interface LineSeries {
  key: string;
  label: string;
  color: string;
  width: number;
  /** An SVG dasharray; empty for a solid line. */
  dash: string;
  /** The series that matters: drawn last, over a faint fill, at full opacity. */
  lead?: boolean;
  /** Writes the newest day's value just past the line's end. */
  endLabel?: boolean;
}

export type LineRow = { date: string } & Record<string, number | string>;

export interface LineChartSpec {
  series: readonly LineSeries[];
  /** Oldest day first. */
  rows: LineRow[];
  format: (v: number) => string;
  /** Counts of whole things: no gridline between two whole numbers. */
  integer?: boolean;
  /** The axis never tops out below this, so a near-empty week still gets a few lines. */
  floor?: number;
  /** Draw the series legend above the chart (left out for a single series). */
  legend?: boolean;
}

const W = 420, H = 160, MT = 10, MB = 24;
// Faint lines closer together than this (in viewBox px) blur into a band.
const MIN_MINOR_GAP = 6;

/** The y-axis, in two kinds of gridline like a game health bar: a solid,
 *  labelled line every `major`, the largest power of ten under the peak, and
 *  a faint one every `minor` (a tenth of that) when those sit far enough apart
 *  to tell. So a line always means a round amount, and the key under the
 *  title says which. Pure, for tests. */
export function tierScale(max: number, plotH: number, opts: { integer?: boolean, floor?: number } = {}): { top: number, major: number, minor: number | null } {
  // At least 1, so an all-zero range still gets a 0 and a 1 line instead of a NaN scale.
  const peak = Math.max(max, opts.floor ?? 0, 1);
  const major = 10 ** Math.floor(Math.log10(peak));
  let minor: number | null = major / 10;
  if (opts.integer && minor < 1) minor = null;
  if (minor !== null && plotH / (Math.ceil(peak / minor)) < MIN_MINOR_GAP) minor = null;
  const unit = minor ?? major;
  return { top: Math.ceil(peak / unit - 1e-9) * unit, major, minor };
}

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

/** A short line sample for the legend, the gridline key and the tooltip. */
function swatch(color: string, width: number, dash = "", opacity = 1): string {
  return `<svg class="pd-line-sw" viewBox="0 0 14 4" width="14" height="4"><line x1="1" x2="13" y1="2" y2="2" stroke="${color}" stroke-width="${width}" stroke-linecap="round" opacity="${opacity}"${dash ? ` stroke-dasharray="${dash}"` : ""}/></svg>`;
}

const MAJOR_OPACITY = 0.9;
const MINOR_OPACITY = 0.3;

interface Geom { n: number, ml: number, pw: number, ph: number, top: number }

function geometry(spec: LineChartSpec): Geom & { major: number, minor: number | null } {
  const values = spec.rows.flatMap((r) => spec.series.map((s) => Number(r[s.key]) || 0));
  const ph = H - MT - MB;
  const { top, major, minor } = tierScale(Math.max(0, ...values), ph, spec);
  // Room for the widest axis label at 8.5px Fira Code (about 5.2px a character).
  const widest = Math.max(...Array.from({ length: Math.floor(top / major) + 1 }, (_, k) => spec.format(k * major).length));
  const ml = Math.round(widest * 5.2 + 8);
  const mr = spec.series.some((s) => s.endLabel) ? 44 : 10;
  return { n: spec.rows.length, ml, pw: W - ml - mr, ph, top, major, minor };
}

const xAt = (g: Geom, i: number): number => g.ml + (g.n === 1 ? g.pw / 2 : (i / (g.n - 1)) * g.pw);
const yAt = (g: Geom, v: number): number => MT + (1 - v / g.top) * g.ph;

function chartSvg(spec: LineChartSpec, g: ReturnType<typeof geometry>): string {
  const { rows, series, format } = spec;
  const { n } = g;
  const base = MT + g.ph;
  const right = g.ml + g.pw;
  const val = (r: LineRow, k: string): number => Number(r[k]) || 0;
  const gridLine = (v: number, kind: "major" | "minor"): string => {
    const gy = yAt(g, v).toFixed(1);
    return `<line data-line-grid="${kind}" x1="${g.ml}" x2="${right}" y1="${gy}" y2="${gy}" stroke="var(--color-border)" stroke-width="1" opacity="${kind === "major" ? MAJOR_OPACITY : MINOR_OPACITY}"/>`;
  };
  // Faint lines first, skipping any that a solid one covers.
  const minors = g.minor === null ? "" : Array.from({ length: Math.round(g.top / g.minor) + 1 }, (_, k) => k * g.minor!)
    .filter((v) => Math.abs(v / g.major - Math.round(v / g.major)) > 1e-6)
    .map((v) => gridLine(v, "minor")).join("");
  const majors = Array.from({ length: Math.floor(g.top / g.major + 1e-9) + 1 }, (_, k) => {
    const v = k * g.major;
    return `${gridLine(v, "major")}
      <text x="${g.ml - 6}" y="${(yAt(g, v) + 3).toFixed(1)}" text-anchor="end" fill="var(--sb-muted)" font-size="8.5" font-family="Fira Code,monospace">${format(v)}</text>`;
  }).join("");
  // At most ~5 date labels, always including the newest day.
  const every = Math.max(1, Math.ceil(n / 5));
  const dates = rows.map((r, i) => ((n - 1 - i) % every === 0
    ? `<text x="${xAt(g, i).toFixed(1)}" y="${H - 6}" text-anchor="middle" fill="var(--sb-muted)" font-size="8.5" font-family="DM Sans,system-ui">${r.date.slice(5)}</text>`
    : "")).join("");
  // Context lines first, so the lead line is drawn over them.
  const ordered = [...series.filter((s) => !s.lead), ...series.filter((s) => s.lead)];
  const lines = ordered.map((s) => {
    if (n === 1) return `<circle data-line="${s.key}" cx="${xAt(g, 0).toFixed(1)}" cy="${yAt(g, val(rows[0]!, s.key)).toFixed(1)}" r="3.5" fill="${s.color}"/>`;
    const path = smoothPath(rows.map((r, i) => [xAt(g, i), yAt(g, val(r, s.key))]));
    const fill = s.lead
      ? `<path d="${path} L${xAt(g, n - 1).toFixed(1)},${base} L${xAt(g, 0).toFixed(1)},${base} Z" fill="${s.color}" opacity="0.08"/>`
      : "";
    return `${fill}<path data-line="${s.key}" d="${path}" fill="none" stroke="${s.color}" stroke-width="${s.width}" stroke-linecap="round"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}${s.lead ? "" : ` opacity="0.7"`}/>`;
  }).join("");
  const last = rows[n - 1]!;
  const ends = series.filter((s) => s.endLabel).map((s) =>
    `<text x="${(xAt(g, n - 1) + 6).toFixed(1)}" y="${(yAt(g, val(last, s.key)) + 3.5).toFixed(1)}" fill="var(--color-text)" font-size="10" font-weight="600" font-family="DM Sans,system-ui">${format(val(last, s.key))}</text>`).join("");
  const dots = series.map((s) => `<circle data-line-dot="${s.key}" r="${s.lead ? 3.5 : 2.5}" fill="${s.color}" stroke="var(--color-surface)" stroke-width="1.5" visibility="hidden"/>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible" data-line-chart data-n="${n}">${minors}${majors}${dates}${lines}${ends}
    <line data-line-cross y1="${MT}" y2="${base}" stroke="var(--color-border)" stroke-width="1" visibility="hidden"/>${dots}</svg>`;
}

/** Crosshair and tooltip for the day under the pointer. Moves existing nodes
 *  in place rather than repainting the dashboard on every mouse move. */
function hover(e: PointerEvent, spec: LineChartSpec, g: Geom): void {
  const wrap = e.currentTarget as HTMLElement;
  const svg = wrap.querySelector<SVGSVGElement>("svg[data-line-chart]");
  const tip = wrap.querySelector<HTMLElement>(".pd-line-tip");
  if (!svg || !tip || !g.n) return;
  const box = svg.getBoundingClientRect();
  if (!box.width) return;
  const vx = ((e.clientX - box.left) / box.width) * W;
  const i = g.n === 1 ? 0 : Math.min(g.n - 1, Math.max(0, Math.round(((vx - g.ml) / g.pw) * (g.n - 1))));
  const row = spec.rows[i]!;
  const cx = xAt(g, i);
  const cross = svg.querySelector("[data-line-cross]");
  cross?.setAttribute("x1", cx.toFixed(1));
  cross?.setAttribute("x2", cx.toFixed(1));
  cross?.setAttribute("visibility", "visible");
  for (const s of spec.series) {
    const dot = svg.querySelector(`[data-line-dot="${s.key}"]`);
    dot?.setAttribute("cx", cx.toFixed(1));
    dot?.setAttribute("cy", yAt(g, Number(row[s.key]) || 0).toFixed(1));
    dot?.setAttribute("visibility", "visible");
  }
  tip.replaceChildren();
  const head = document.createElement("div");
  head.className = "pd-line-tip-date";
  head.textContent = row.date;
  tip.append(head);
  for (const s of spec.series) {
    const line = document.createElement("div");
    line.innerHTML = swatch(s.color, Math.max(1.5, s.width), s.dash);
    line.append(`${s.label} ${spec.format(Number(row[s.key]) || 0)}`);
    tip.append(line);
  }
  tip.hidden = false;
  // Flip to the left of the crosshair past the middle, so it never leaves the card.
  const px = (cx / W) * box.width;
  const left = px > box.width / 2 ? px - tip.offsetWidth - 10 : px + 10;
  tip.style.left = `${Math.max(0, left)}px`;
}

function unhover(e: PointerEvent): void {
  const wrap = e.currentTarget as HTMLElement;
  wrap.querySelectorAll("[data-line-cross], [data-line-dot]").forEach((n) => n.setAttribute("visibility", "hidden"));
  const tip = wrap.querySelector<HTMLElement>(".pd-line-tip");
  if (tip) tip.hidden = true;
}

/** The legend row (series on the left, what each kind of gridline is worth on
 *  the right) and the chart under it. The key's samples use the muted text
 *  color rather than the gridlines' own border color, which at 14px wide
 *  vanishes into the card. */
export function lineChart(spec: LineChartSpec): TemplateResult {
  const g = geometry(spec);
  const key = html`<span class="pd-line-key" title="What one gridline is worth">
    <span data-line-key="major">${unsafeHTML(swatch("var(--sb-muted)", 1.5))}${spec.format(g.major)}</span>
    ${g.minor === null ? nothing : html`<span data-line-key="minor">${unsafeHTML(swatch("var(--sb-muted)", 1.5, "", 0.4))}${spec.format(g.minor)}</span>`}
  </span>`;
  return html`
    <div class="pd-line-legend">${spec.legend
      ? spec.series.map((s) => html`<span>${unsafeHTML(swatch(s.color, Math.max(1.5, s.width), s.dash))}${s.label}</span>`)
      : nothing}${key}</div>
    <div class="pd-line-chart" @pointermove=${(e: PointerEvent) => hover(e, spec, g)} @pointerleave=${unhover}>
      ${unsafeHTML(chartSvg(spec, g))}<div class="pd-line-tip" hidden></div>
    </div>`;
}
