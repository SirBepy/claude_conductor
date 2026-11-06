// Draws a message's `visuals` (message-visuals.ts) as the HTML that sits under a
// card's body. Everything the model wrote is escaped here: a visual is data, and
// assistant text is not a trust boundary. Colours are the app theme's custom
// properties, so every theme and the phone get the same look for free.

import { escapeHtml } from "../escape-html";
import { wrapTables } from "./markdown-highlight";
import type { BarVisual, DonutVisual, LineVisual, TableVisual, TimelineVisual, Visual } from "./message-visuals";

const COLORS = ["var(--color-primary)", "var(--color-secondary)", "var(--color-success)", "var(--color-warning)", "var(--color-info)"];
const color = (i: number) => COLORS[i % COLORS.length]!;

const esc = escapeHtml;

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

const NUMERIC_CELL = /^[~<>+-]?\s*[$€£]?\s*-?\d[\d,.\s]*\s*(%|[a-zA-Zµ]{0,3})$/;

function figure(title: string | undefined, cls: string, inner: string): string {
  const cap = title ? `<figcaption>${esc(title)}</figcaption>` : "";
  return `<figure class="mv-fig ${cls}">${cap}${inner}</figure>`;
}

function tableHtml(v: TableVisual): string {
  // A column is numeric when every cell in it is a number or reads like one; numbers right-align.
  const numeric = v.columns.map((_, c) => v.rows.every((r) => typeof r[c] === "number" || r[c] === null || NUMERIC_CELL.test(String(r[c]).trim())));
  const cell = (tag: string, c: number, text: string) => `<${tag}${numeric[c] ? ' class="mv-num"' : ""}>${esc(text)}</${tag}>`;
  const head = v.columns.map((c, i) => cell("th", i, c)).join("");
  const body = v.rows
    .map((r) => `<tr>${r.map((c, i) => cell("td", i, typeof c === "number" ? fmt(c) : (c ?? ""))).join("")}</tr>`)
    .join("");
  // wrapTables adds the fullscreen and per-cell copy buttons markdown tables already get.
  return figure(v.title, "mv-table", wrapTables(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`));
}

function barHtml(v: BarVisual): string {
  const max = Math.max(...v.data.map((d) => d.value), 0);
  const unit = v.unit ?? "";
  const rows = v.data
    .map((d, i) => {
      const pct = max > 0 ? (d.value / max) * 100 : 0;
      return `<div class="mv-bar-row"><span class="mv-bar-l" title="${esc(d.label)}">${esc(d.label)}</span><span class="mv-bar-track"><i style="width:${pct.toFixed(1)}%;background:${color(i)}"></i></span><b class="mv-num">${esc(fmt(d.value) + unit)}</b></div>`;
    })
    .join("");
  return figure(v.title, "mv-bar", `<div class="mv-bars">${rows}</div>`);
}

function lineHtml(v: LineVisual): string {
  // 360 wide so a phone card scales the 10px axis text to about 9px instead of 7.
  const W = 360;
  const H = 140;
  const [pl, pr, pt, pb] = [30, 10, 8, 20];
  const top = Math.max(...v.series.flatMap((s) => s.values), 0) * 1.1 || 1;
  const x = (i: number) => pl + (i * (W - pl - pr)) / (v.labels.length - 1);
  const y = (n: number) => pt + (H - pt - pb) * (1 - n / top);
  const grid = [0, 0.5, 1]
    .map((f) => `<line x1="${pl}" x2="${W - pr}" y1="${y(top * f).toFixed(1)}" y2="${y(top * f).toFixed(1)}" class="mv-grid"/><text x="${pl - 5}" y="${(y(top * f) + 3).toFixed(1)}" text-anchor="end" class="mv-axis">${esc(fmt(Math.round(top * f)))}</text>`)
    .join("");
  // Thin the x labels so a long series stays legible; the first and last always show.
  const every = Math.ceil(v.labels.length / 8);
  const xl = v.labels
    .map((l, i) => {
      const last = i === v.labels.length - 1;
      // The last label hangs left of its point: centred, a long one runs off the viewBox and is cut.
      return i % every === 0 || last ? `<text x="${x(i).toFixed(1)}" y="${H - 4}" text-anchor="${last ? "end" : "middle"}" class="mv-axis">${esc(l)}</text>` : "";
    })
    .join("");
  const lines = v.series
    .map((s, si) => {
      const pts = s.values.map((n, i) => `${x(i).toFixed(1)},${y(n).toFixed(1)}`).join(" ");
      const dots = v.labels.length <= 12 ? s.values.map((n, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(n).toFixed(1)}" r="2.5" fill="${color(si)}"><title>${esc(`${s.name}, ${v.labels[i]}: ${fmt(n)}`)}</title></circle>`).join("") : "";
      return `<polyline fill="none" stroke="${color(si)}" stroke-width="2" stroke-linejoin="round" points="${pts}"/>${dots}`;
    })
    .join("");
  const legend = v.series.length > 1 ? `<div class="mv-legend">${v.series.map((s, i) => `<span class="mv-key"><i style="background:${color(i)}"></i>${esc(s.name)}</span>`).join("")}</div>` : "";
  return figure(v.title, "mv-line", `<svg viewBox="0 0 ${W} ${H}" class="mv-svg" role="img" aria-label="${esc(v.title ?? "Line chart")}">${grid}${xl}${lines}</svg>${legend}`);
}

function donutHtml(v: DonutVisual): string {
  const total = v.data.reduce((a, d) => a + d.value, 0);
  const R = 42;
  const C = 2 * Math.PI * R;
  let off = 0;
  const arcs = v.data
    .map((d, i) => {
      const len = (d.value / total) * C;
      const arc = `<circle r="${R}" cx="60" cy="60" fill="none" stroke="${color(i)}" stroke-width="16" stroke-dasharray="${Math.max(len - 1.5, 0.1).toFixed(2)} ${(C - len + 1.5).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 60 60)"><title>${esc(`${d.label}: ${fmt(d.value)}`)}</title></circle>`;
      off += len;
      return arc;
    })
    .join("");
  const legend = v.data
    .map((d, i) => `<span class="mv-key"><i style="background:${color(i)}"></i>${esc(d.label)}<b class="mv-num">${Math.round((d.value / total) * 100)}%</b></span>`)
    .join("");
  const svg = `<svg viewBox="0 0 120 120" class="mv-svg-sm" role="img" aria-label="${esc(v.title ?? "Donut chart")}">${arcs}<text x="60" y="58" text-anchor="middle" class="mv-donut-n">${esc(fmt(total))}</text><text x="60" y="73" text-anchor="middle" class="mv-axis">total</text></svg>`;
  return figure(v.title, "mv-donut", `<div class="mv-donut-row">${svg}<div class="mv-legend mv-legend--col">${legend}</div></div>`);
}

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const duration = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${m}m`);

function timelineHtml(v: TimelineVisual): string {
  const all = v.rows.flatMap((r) => r.blocks);
  // Whole hours, and never thinner than 4h, so a single short block does not fill the track.
  let lo = Math.floor(Math.min(...all.map((b) => b.start)) / 60) * 60;
  let hi = Math.ceil(Math.max(...all.map((b) => b.end)) / 60) * 60;
  if (hi - lo < 240) {
    hi = Math.min(lo + 240, 24 * 60);
    lo = Math.max(hi - 240, 0);
  }
  const span = hi - lo;
  // At most six ticks: on a phone card hourly labels over a working day touch each other.
  const step = [60, 120, 180, 240, 360].find((st) => span / st <= 5) ?? 360;
  const ticks: string[] = [];
  for (let m = lo; m <= hi; m += step) ticks.push(`<span class="mv-tick" style="left:${(((m - lo) / span) * 100).toFixed(2)}%">${hhmm(m).slice(0, 2)}</span>`);
  const rows = v.rows
    .map((r) => {
      const total = r.blocks.reduce((a, b) => a + (b.end - b.start), 0);
      const blocks = r.blocks
        .map((b, i) => {
          const left = ((b.start - lo) / span) * 100;
          const width = ((b.end - b.start) / span) * 100;
          const tip = `${b.label ? b.label + ", " : ""}${hhmm(b.start)} to ${hhmm(b.end)} (${duration(b.end - b.start)})`;
          return `<i class="mv-block" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%;--c:${color(i)}" title="${esc(tip)}">${b.label ? `<span>${esc(b.label)}</span>` : ""}</i>`;
        })
        .join("");
      return `<div class="mv-tl-row"><span class="mv-tl-l" title="${esc(r.label)}">${esc(r.label)}</span><span class="mv-tl-track">${blocks}</span><b class="mv-num">${esc(duration(total))}</b></div>`;
    })
    .join("");
  return figure(v.title, "mv-timeline", `<div class="mv-tl"><div class="mv-tl-axis"><span></span><span class="mv-tl-ticks">${ticks.join("")}</span><span></span></div>${rows}</div>`);
}

function renderVisual(v: Visual): string {
  switch (v.type) {
    case "table": return tableHtml(v);
    case "bar": return barHtml(v);
    case "line": return lineHtml(v);
    case "donut": return donutHtml(v);
    case "timeline": return timelineHtml(v);
  }
}

/** The block a card puts under its body; empty when there is nothing to draw. */
export function renderVisuals(visuals: readonly Visual[] | undefined): string {
  return visuals?.length ? `<div class="mv-visuals">${visuals.map(renderVisual).join("")}</div>` : "";
}
