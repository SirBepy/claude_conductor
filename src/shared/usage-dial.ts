// Dial-ring rendering (SVG rings + centre icon) for one account's usage,
// extracted from the overlay window (milestone 06 - see .for_bepy/overlay-
// circle-mockup.html for the design this ports) so the remote/phone header's
// multi-account dial row (usage-dials.ts) can reuse the exact same visuals
// instead of a second implementation drifting from it over time. Pair with
// `views/overlay/overlay.css`'s `.oc-*` classes, imported by both consumers.

import { escapeHtml } from "./escape-html";
import { valueColor } from "./formatters";
import type { ValueColorSettings } from "./formatters";
import type { OverlayMetric, OverlayRow } from "../views/overlay/overlay-logic";

// Dial geometry — ported 1:1 from the mockup's arc()/seg()/ring()/dial() so
// the rendered result matches it exactly (viewBox 0 0 44 44, centre 22,22).
export const OUTER_R = 19;
export const OUTER_W = 4.5;
export const INNER_R = 12;
export const INNER_W = 3;
const TRACK_COLOR = "var(--color-surface-alt, #262637)";
// Filled backing disc behind each dial (circles mode). Sized to sit a
// `DISC_PAD` gap OUTSIDE the outer ring so the graph is padded within the disc
// rather than touching its rim.
const DISC_PAD = 4;
const DISC_R = OUTER_R + OUTER_W / 2 + DISC_PAD;
// Small breathing gap around the rings in card mode, where a shared row card
// (not a per-dial disc) is the backing.
const CARD_MARGIN = 2;

/** Uniform scale from viewBox units to rendered px. >1 enlarges the whole
 * dial (rings + disc + icon together). `scale` lets callers render a smaller
 * variant (e.g. the remote header's compact row) without redoing the maths. */
export function dialGeometry(
  showDisc: boolean,
  scale = 1.2,
): { viewBox: string; sizeCss: string } {
  const margin = showDisc ? DISC_PAD : CARD_MARGIN;
  const size = 44 + 2 * margin;
  const px = Math.round(size * scale);
  return { viewBox: `${-margin} ${-margin} ${size} ${size}`, sizeCss: `width:${px}px;height:${px}px` };
}

/** One arc's dasharray + rotation, matching the mockup's `arc()`. */
function arcGeometry(r: number, startPct: number, lenPct: number): { dash: string; rot: string } {
  const c = 2 * Math.PI * r;
  const dash = `${((lenPct / 100) * c).toFixed(2)} ${c.toFixed(2)}`;
  const rot = (-90 + (startPct / 100) * 360).toFixed(2);
  return { dash, rot };
}

/** One arc segment, matching the mockup's `seg()`. */
function seg(r: number, w: number, startPct: number, lenPct: number, stroke: string, cap: boolean, opacity?: number): string {
  const a = arcGeometry(r, startPct, lenPct);
  const capAttr = cap ? ' stroke-linecap="round"' : "";
  const opacityAttr = opacity != null ? ` opacity="${opacity}"` : "";
  return `<circle cx="22" cy="22" r="${r}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-dasharray="${a.dash}" transform="rotate(${a.rot} 22 22)"${capAttr}${opacityAttr}/>`;
}

/**
 * One ring (either the 5h or the 7d), matching the mockup's `ring()` exactly:
 * a full-track base, then either a single solid arc (on pace), a faded
 * safe-pace arc under a solid current arc (under pace — solid up to current,
 * ghost out to the safe mark), or a bright current arc under a darker
 * safe-pace arc (over pace — darker up to safe, bright for the overshoot).
 */
function ring(r: number, w: number, cur: number, safe: number, color: string): string {
  let out = seg(r, w, 0, 100, TRACK_COLOR, false);
  if (cur === safe) {
    out += seg(r, w, 0, cur, color, true);
  } else if (cur < safe) {
    out += seg(r, w, 0, safe, color, true, 0.3);
    out += seg(r, w, 0, cur, color, true);
  } else {
    const darker = `color-mix(in srgb, ${color} 52%, #08060c)`;
    out += seg(r, w, 0, cur, color, true);
    out += seg(r, w, 0, safe, darker, true);
  }
  return out;
}

/** Base ring colour for one metric: the app's settings-driven pace colour
 * (getPaceColor, via valueColor which also honours the existing colorApplyTo
 * "off" escape hatch and falls back to a plain percent-threshold colour when
 * there's no safe-pace anchor yet) — never a hand-rolled green/amber/red. */
function metricColor(metric: OverlayMetric, settings: ValueColorSettings): string {
  if (metric.pct == null) return "var(--color-text-muted, #8a8aa0)";
  return valueColor(metric.pct, metric.safePct, settings, "overlay");
}

/** SVG for one ring, degrading to a bare track when there's no data yet, and
 * to a single solid arc (no faded/darker split) when there's data but no
 * safe-pace anchor to compare it against (e.g. no active reset window). */
function ringSvg(r: number, w: number, metric: OverlayMetric, settings: ValueColorSettings): string {
  if (metric.pct == null) return seg(r, w, 0, 100, TRACK_COLOR, false);
  const cur = Math.max(0, Math.min(100, metric.pct));
  const safe = metric.safePct != null ? Math.max(0, Math.min(100, metric.safePct)) : cur;
  return ring(r, w, cur, safe, metricColor(metric, settings));
}

export function dialHtml(
  row: OverlayRow,
  settings: ValueColorSettings,
  showDisc: boolean,
  scale = 1.2,
): string {
  const outer = ringSvg(OUTER_R, OUTER_W, row.session, settings);
  const inner = ringSvg(INNER_R, INNER_W, row.weekly, settings);
  const icon = escapeHtml(row.icon);
  // Centre icon carries the account's own colour (identity); the rings carry
  // pace status. Falls back to the CSS neutral when an account has no colour.
  const iconColor = row.colour ? ` style="color:${escapeHtml(row.colour)}"` : "";
  // Circles mode draws a per-dial backing disc; card mode omits it (a shared
  // row card is the backing instead — see .oc-dial-row.oc-card in overlay.css).
  const disc = showDisc ? `<circle class="oc-disc" cx="22" cy="22" r="${DISC_R}"/>` : "";
  const { viewBox, sizeCss } = dialGeometry(showDisc, scale);
  // Spinner glyph sits alongside the account icon at all times, hidden by
  // default — the caller toggles an `oc-refreshing` class on an ancestor
  // while a refresh is in flight, so the dial visibly "works" instead of the
  // icon just silently updating once new data lands.
  const icons = `<i class="ph ph-${icon} oc-ic-glyph"></i><i class="ph ph-spinner oc-ic-spin"></i>`;
  return `<div class="oc-dial" style="${sizeCss}"><svg viewBox="${viewBox}" style="${sizeCss}">${disc}${outer}${inner}</svg><div class="oc-ic"${iconColor}>${icons}</div></div>`;
}

/** One `<cur>%/<safe>%` line inside the hover info circle, the current %
 * tinted by pace colour. Shows `--` when there's no data yet. */
function infoMetricLine(metric: OverlayMetric, settings: ValueColorSettings): string {
  const color = metricColor(metric, settings);
  const curText = metric.pct != null ? `${metric.pct}%` : "--";
  const safeText = metric.safePct != null ? `/${metric.safePct}%` : "";
  return `<div class="oc-info-row"><b style="color:${escapeHtml(color)}">${curText}</b><span class="oc-info-safe">${escapeHtml(safeText)}</span></div>`;
}

/** Hover content shown INSIDE the circle in place of the graph: the account
 * name plus the session/weekly current%/safe% lines (top = session, bottom =
 * weekly). Fades in (and the dial graph fades out) on cell hover — see
 * .oc-info in overlay.css. */
function infoHtml(row: OverlayRow, settings: ValueColorSettings): string {
  return `<div class="oc-info">
    <div class="oc-info-nm">${escapeHtml(row.label)}</div>
    ${infoMetricLine(row.session, settings)}
    ${infoMetricLine(row.weekly, settings)}
  </div>`;
}

export function cellHtml(
  row: OverlayRow,
  settings: ValueColorSettings,
  showDisc: boolean,
  scale = 1.2,
): string {
  return `<div class="oc-cell" data-acc-id="${escapeHtml(row.id)}">
    ${dialHtml(row, settings, showDisc, scale)}
    ${infoHtml(row, settings)}
  </div>`;
}
