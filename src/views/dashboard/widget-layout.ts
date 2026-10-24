// Dashboard widget layout: full-width widgets stack in reading order, and each
// run of adjacent half-width widgets (the charts and their by-project bars)
// shares a two-column block balanced by measured height, the same placement
// the Projects dashboard uses. The run is worked out from the current order
// and enabled set, so reordering or disabling a widget never leaves a hole.

import type { DashboardWidgetEntry } from "./widget-registry";
import { getWidget } from "./widget-registry";
import { assignColumns, halfRuns, naturalHeight } from "../../shared/balance";
import { debounce } from "../../shared/debounce";

/** Below this block width two columns are too cramped for a chart, so the run
 *  stacks in reading order instead. */
const ONE_COLUMN_PX = 640;
const RESIZE_DEBOUNCE_MS = 100;
/** A chart drawn within this many px of its body's width is left alone. */
const CHART_WIDTH_SLACK_PX = 4;

/** Shell markup for the enabled widgets, half-width runs wrapped in a pair
 *  block. Until a paint measures them, a run's widgets alternate columns. */
export function widgetsGridHtml(
  enabled: DashboardWidgetEntry[],
  shell: (entry: DashboardWidgetEntry, index: number) => string,
): string {
  const index = new Map(enabled.map((e, i) => [e, i]));
  return halfRuns(enabled, (e) => getWidget(e.id)?.half === true).map((item) => {
    if (!Array.isArray(item)) return shell(item, index.get(item)!);
    const col = (n: number): string =>
      item.filter((_, i) => i % 2 === n).map((e) => shell(e, index.get(e)!)).join("");
    // data-order on each widget keeps the reading order once columns reshuffle.
    return `<div class="dash-pair"><div class="dash-col">${col(0)}</div><div class="dash-col">${col(1)}</div></div>`;
  }).join("");
}

/** Re-places every pair block's widgets by measured height. */
export function rebalanceWidgets(container: HTMLElement): void {
  for (const pair of container.querySelectorAll<HTMLElement>(".dash-pair")) {
    const cols = [...pair.querySelectorAll<HTMLElement>(":scope > .dash-col")];
    if (cols.length !== 2) continue;
    const widgets = [...pair.querySelectorAll<HTMLElement>(".dash-widget")]
      .sort((a, b) => Number(a.dataset["order"]) - Number(b.dataset["order"]));
    const single = pair.clientWidth > 0 && pair.clientWidth < ONE_COLUMN_PX;
    let next: Array<0 | 1>;
    if (single) next = widgets.map((): 0 | 1 => 0);
    else {
      const heights = widgets.map(naturalHeight);
      // Hidden view: every height reads 0. Keep the placement until it shows.
      if (heights.every((h) => h === 0)) continue;
      next = assignColumns(heights);
    }
    pair.classList.toggle("is-single", single);
    const unchanged = widgets.every((w, i) => w.parentElement === cols[next[i]!]);
    if (unchanged) continue;
    // Appending in reading order keeps each column's own order right.
    widgets.forEach((w, i) => cols[next[i]!]!.appendChild(w));
  }
}

/** Ids of the widgets whose chart was drawn at a width its body no longer has.
 *  A chart's viewBox is fixed at draw time, so after a column change the SVG
 *  (width 100%) scales and its axis text with it. A hidden body (width 0) is
 *  skipped: it gets its real width when it shows. */
export function chartsDrawnAtStaleWidth(container: HTMLElement): string[] {
  const ids: string[] = [];
  for (const svg of container.querySelectorAll<SVGElement>(".dash-widget-body svg[data-w]")) {
    const body = svg.closest<HTMLElement>(".dash-widget-body");
    const id = svg.closest<HTMLElement>(".dash-widget")?.dataset["widgetId"];
    if (!body || !id || body.clientWidth === 0) continue;
    if (Math.abs(body.clientWidth - Number(svg.dataset["w"])) > CHART_WIDTH_SLACK_PX && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Rebalances whenever the widget area changes width or a widget body changes
 *  height (its data arriving after mount), then has `redraw` re-draw every
 *  chart whose width changed. Bodies, not widgets, are watched: a widget is
 *  stretched to fill its column, so its own box hides the change. */
export function observeWidgetLayout(container: HTMLElement, redraw: (widgetId: string) => void): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  const run = debounce(() => {
    rebalanceWidgets(container);
    for (const id of chartsDrawnAtStaleWidth(container)) redraw(id);
  }, RESIZE_DEBOUNCE_MS);
  const obs = new ResizeObserver(() => run());
  obs.observe(container);
  container.querySelectorAll(".dash-pair .dash-widget-body").forEach((b) => obs.observe(b));
  return () => { obs.disconnect(); run.cancel(); };
}
