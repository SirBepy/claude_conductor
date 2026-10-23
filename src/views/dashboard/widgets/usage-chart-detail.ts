// Graph detail modal: the full-page chart/bars view opened via "show more"
// from a widget card (pagination through older sessions/weeks), rendered
// into the pre-existing static #view-graph-detail view. Split out of
// usage-charts.ts, see .for_bepy/ai_todos/177-split-usage-charts-widget-file.md.

import { showView } from "../../../shared/navigation";
import { wireProjectListClicks } from "./project-list";
import type { UsageRecord } from "../../../shared/api";
import { buildChart, buildWindowProjectsHTML, setupChartHover } from "./usage-chart-view";
import { buildProjectBarsView, wireBarsMore } from "./usage-bars-view";
import { fetchHistory, sessionWindow, weeklyWindow, stepPageOffset } from "./usage-charts";

export interface GraphCardOpts {
  metric: "session" | "weekly";
  kind: "chart" | "bars";
  history: UsageRecord[];
  startMs: number;
  endMs: number;
  lineKey: "s" | "w";
  pctKey: "s" | "w";
  pageOffset: number;
  hasPrev: boolean;
  pageLabel: string;
  legends: string[];
  maxItems: number | null;
  /** Pixel width the chart is drawn at; omitted, it scales from 420. */
  chartWidth?: number;
}

// Keyed by projectListId, per selected account (a listId embeds startMs, so
// this only grows across pagination within one mount - acceptable, mirrors
// the pre-migration statistics.ts module-level cache).
const graphDetailConfigs: Record<string, { opts: GraphCardOpts; accountId: string | null }> = {};

export function buildGraphCard(opts: GraphCardOpts, accountId: string | null): string {
  const { metric, kind, history, startMs, endMs, lineKey, pctKey,
    pageOffset, hasPrev, pageLabel, legends, maxItems } = opts;
  const cardId = `${metric}-${kind}`;
  const svgId = `chart-${cardId}`;
  const projectListId = `window-${cardId}-${startMs}`;
  const prevId = `prev-${cardId}`;
  const nextId = `next-${cardId}`;

  graphDetailConfigs[projectListId] = { opts, accountId };

  const content = kind === "chart"
    ? `<div class="chart-legend">${legends.join("")}</div>
       ${buildChart(history, startMs, endMs, lineKey, svgId, opts.chartWidth)}
       ${buildWindowProjectsHTML(startMs, endMs, history, pctKey, maxItems, projectListId)}`
    : buildProjectBarsView(startMs, endMs, history, pctKey, maxItems, projectListId);

  return `<div class="chart-container" style="margin-bottom:12px">
    <div class="chart-pagination">
      <button id="${prevId}" data-page-nav="prev" data-page-graph="${metric}" class="btn-secondary nav-arrow left" ${hasPrev ? "" : "disabled"}>◀</button>
      <span class="chart-pagination-label">${pageLabel}</span>
      <button id="${nextId}" data-page-nav="next" data-page-graph="${metric}" class="btn-secondary nav-arrow right" ${pageOffset === 0 ? "disabled" : ""}>▶</button>
    </div>
    ${content}
  </div>`;
}

// ── Graph detail view (opened via show-more) ───────────────────────────────

function detailTitle(opts: GraphCardOpts): string {
  const m = opts.metric === "session" ? "Session" : "Weekly";
  const k = opts.kind === "chart" ? "chart" : "bars";
  return `${m} ${k}`;
}

export function openGraphDetail(listId: string): void {
  const entry = graphDetailConfigs[listId];
  if (!entry) return;
  const { opts: config, accountId } = entry;

  const container = document.getElementById("graph-detail-content");
  const title = document.getElementById("graphDetailTitle");
  if (!container) return;
  if (title) title.textContent = detailTitle(config);

  container.innerHTML = buildGraphCard({ ...config, maxItems: null }, accountId);
  wireDetailNav(container, config.metric, config.kind, accountId);
  wireProjectListClicks(container, () => renderGraphDetailFromCurrent(config.metric, config.kind, accountId));
  wireBarsMore(container, (id) => openGraphDetail(id));
  setupChartHover(container);
  showView("graph-detail");
}

function wireDetailNav(container: HTMLElement, metric: "session" | "weekly", kind: "chart" | "bars", accountId: string | null): void {
  const cardId = `${metric}-${kind}`;
  const prevBtn = container.querySelector<HTMLButtonElement>(`#prev-${cardId}`);
  const nextBtn = container.querySelector<HTMLButtonElement>(`#next-${cardId}`);
  if (prevBtn) prevBtn.onclick = () => { stepPageOffset(metric, "prev"); void renderGraphDetailFromCurrent(metric, kind, accountId); };
  if (nextBtn) nextBtn.onclick = () => { stepPageOffset(metric, "next"); void renderGraphDetailFromCurrent(metric, kind, accountId); };
}

async function renderGraphDetailFromCurrent(metric: "session" | "weekly", kind: "chart" | "bars", accountId: string | null): Promise<void> {
  const lastHistory = await fetchHistory(accountId);
  if (!lastHistory.length) return;

  let config: GraphCardOpts;
  if (metric === "session") {
    config = { ...sessionWindow(lastHistory), metric: "session", kind, history: lastHistory, maxItems: null };
  } else {
    config = { ...weeklyWindow(lastHistory), metric: "weekly", kind, history: lastHistory, maxItems: null };
  }

  const container = document.getElementById("graph-detail-content");
  if (!container) return;
  const title = document.getElementById("graphDetailTitle");
  if (title) title.textContent = detailTitle(config);
  container.innerHTML = buildGraphCard(config, accountId);
  wireDetailNav(container, metric, kind, accountId);
  wireProjectListClicks(container, () => void renderGraphDetailFromCurrent(metric, kind, accountId));
  wireBarsMore(container, (id) => openGraphDetail(id));
  setupChartHover(container);
}
