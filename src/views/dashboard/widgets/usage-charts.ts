// Account-scoped dashboard widgets: session (5h) and weekly (7d) chart + bars
// (moved from the deleted src/views/statistics/statistics.ts, multi-account
// milestone 05). History is fetched per selected account via
// `api.getHistory({ accountId })`; `accountId: null` (pre-onboarding, empty
// registry) mirrors the old aggregate-history behaviour exactly.
//
// The "show more" -> full-page graph-detail flow (pagination through older
// sessions/weeks) is preserved via the pre-existing static `#view-graph-detail`
// view (src/index.html + main.ts back-button wiring) so no widget capability
// is lost by deleting Statistics.
//
// This file is the widget-registration surface: window math (page offsets,
// session/weekly window bounds) and the four exported Widget objects. Line-
// chart rendering lives in usage-chart-view.ts, the bars view in
// usage-bars-view.ts, and the graph detail modal in usage-chart-detail.ts
// (split out per .for_bepy/ai_todos/177-split-usage-charts-widget-file.md).

import { hourToMs } from "../../../shared/time";
import { api } from "../../../shared/api";
import type { UsageRecord } from "../../../shared/api";
import { wireProjectListClicks } from "./project-list";
import type { Widget, WidgetContext } from "./types";
import {
  applyLineVisibility,
  setupLegendToggles,
  setupPaginationButtons,
  setupChartHover,
} from "./usage-chart-view";
import { wireBarsMore } from "./usage-bars-view";
import { buildGraphCard, openGraphDetail, type GraphCardOpts } from "./usage-chart-detail";

// ── Module-local chart state (page offsets) ────────────────────────────────
// Shared across accounts (mirrors the pre-milestone single-account behaviour;
// switching accounts does not reset "N sessions/weeks ago" pagination).

let sessionPageOffset = 0;
let weeklyPageOffset = 0;

export function getPageOffset(metric: "session" | "weekly"): number {
  return metric === "session" ? sessionPageOffset : weeklyPageOffset;
}

export function stepPageOffset(metric: "session" | "weekly", dir: "prev" | "next"): void {
  const current = getPageOffset(metric);
  const next = dir === "prev" ? current + 1 : Math.max(0, current - 1);
  if (metric === "session") sessionPageOffset = next; else weeklyPageOffset = next;
}

// ── Per-account history fetch ───────────────────────────────────────────────

export async function fetchHistory(accountId: string | null, fromMs?: number): Promise<UsageRecord[]> {
  try {
    return await api.getHistory({ accountId, fromMs });
  } catch (err) {
    console.error("[dashboard] getHistory failed", err);
    return [];
  }
}

/** The 5h session and 7d weekly window lengths. The page windows and the history
 *  prefetch share them so the prefetch always spans what the chart shows. */
const SESSION_MS = 5 * 3_600_000;
const WEEK_MS = 7 * 24 * 3_600_000;

/** History for the chart's current page. The phone holds only the recent days,
 *  so a chart paged back asks for the window it shows plus the one before it
 *  (which decides the "previous" arrow); inside the held days that is a no-op. */
export function fetchHistoryForPage(metric: "session" | "weekly", accountId: string | null): Promise<UsageRecord[]> {
  const windowMs = metric === "session" ? SESSION_MS : WEEK_MS;
  return fetchHistory(accountId, Date.now() - (getPageOffset(metric) + 2) * windowMs);
}

// ── Per-metric window helpers ─────────────────────────────────────────────

export interface WindowState {
  startMs: number;
  endMs: number;
  hasPrev: boolean;
  pageLabel: string;
  pageOffset: number;
  legends: string[];
  lineKey: "s" | "w";
  pctKey: "s" | "w";
}

function legendItem(elId: string, color: string, isDashed: boolean, label: string): string {
  const key = elId.replace(/^legend-/, "");
  const dot = isDashed
    ? `<span style="display:inline-block;width:14px;height:2px;background:${color};vertical-align:middle;margin-right:4px;border-radius:1px;border-top:2px dashed ${color};"></span>`
    : `<span class="legend-dot" style="background:${color}"></span>`;
  return `<span data-legend="${key}" style="cursor:pointer">${dot}${label}</span>`;
}

export function sessionWindow(history: UsageRecord[]): WindowState {
  const latest = history[history.length - 1]!;
  const sessionEndMs = latest.session_resets_at
    ? new Date(latest.session_resets_at).getTime()
    : Date.now() + 3_600_000;
  const shiftMs = sessionPageOffset * SESSION_MS;
  const endMs = sessionEndMs - shiftMs;
  const startMs = endMs - SESSION_MS;
  const hasPrev = history.some((r) => {
    const t = hourToMs(r.hour);
    return t >= startMs - SESSION_MS && t < startMs;
  });
  return {
    startMs, endMs, hasPrev,
    pageLabel: sessionPageOffset === 0 ? "This session" : `${sessionPageOffset} session${sessionPageOffset > 1 ? "s" : ""} ago`,
    pageOffset: sessionPageOffset,
    legends: [legendItem("legend-session", "var(--color-primary)", false, "Session"), legendItem("legend-expected", "var(--color-text-muted)", true, "Expected")],
    lineKey: "s", pctKey: "s",
  };
}

export function weeklyWindow(history: UsageRecord[]): WindowState {
  const latest = history[history.length - 1]!;
  const weeklyEndMs = latest.weekly_resets_at
    ? new Date(latest.weekly_resets_at).getTime()
    : Date.now() + 3_600_000;
  const shiftMs = weeklyPageOffset * WEEK_MS;
  const endMs = weeklyEndMs - shiftMs;
  const startMs = endMs - WEEK_MS;
  const hasPrev = history.some((r) => {
    const t = hourToMs(r.hour);
    return t >= startMs - WEEK_MS && t < startMs;
  });
  return {
    startMs, endMs, hasPrev,
    pageLabel: weeklyPageOffset === 0 ? "This week" : `${weeklyPageOffset}w ago`,
    pageOffset: weeklyPageOffset,
    legends: [legendItem("legend-weekly", "var(--color-secondary)", false, "Weekly"), legendItem("legend-expected", "var(--color-text-muted)", true, "Expected")],
    lineKey: "w", pctKey: "w",
  };
}

// ── Plan without a 5h window ───────────────────────────────────────────────

/** The latest record decides: a plan that gains or loses its 5h limit follows its
 *  current state, and older rows of a limit-free plan only carry the flat 0% the
 *  backend reports for the absent window. */
export function planHasNoSessionWindow(history: UsageRecord[]): boolean {
  return history[history.length - 1]?.session_limited === false;
}

const NO_SESSION_WINDOW_HTML = `<div class="v-empty">
  <i class="ph ph-clock-countdown v-empty-icon"></i>
  <div class="v-empty-title">No 5h limit on this plan</div>
  <div class="v-empty-hint">Only the weekly window is limited, see the weekly widgets.</div>
</div>`;

// ── Widget mount: shared render for the 4 session/weekly x chart/bars combos ──

function mountUsageWidget(
  metric: "session" | "weekly",
  kind: "chart" | "bars",
  root: HTMLElement,
  ctx: WidgetContext,
): (() => void) | void {
  let disposed = false;

  const draw = async () => {
    const history = await fetchHistoryForPage(metric, ctx.accountId);
    if (disposed) return;
    if (!history.length) {
      root.innerHTML = `<div class="v-empty">
        <i class="ph ph-chart-line v-empty-icon"></i>
        <div class="v-empty-title">No history recorded yet</div>
        <div class="v-empty-hint">Data appears after the first successful refresh.</div>
      </div>`;
      return;
    }
    if (metric === "session" && planHasNoSessionWindow(history)) {
      root.innerHTML = NO_SESSION_WINDOW_HTML;
      return;
    }
    const win = metric === "session" ? sessionWindow(history) : weeklyWindow(history);
    // 0 while the view is hidden; the chart then scales from its default width.
    const chartWidth = root.clientWidth || undefined;
    const config: GraphCardOpts = { ...win, metric, kind, history, maxItems: 5, chartWidth };
    root.innerHTML = buildGraphCard(config, ctx.accountId);
    setupLegendToggles(root, () => void draw());
    applyLineVisibility(root);
    setupPaginationButtons(root, () => void draw());
    setupChartHover(root);
    wireBarsMore(root, (id) => openGraphDetail(id));
    wireProjectListClicks(root, () => void draw(), (id) => openGraphDetail(id));
  };

  void draw();

  return () => { disposed = true; };
}

export const sessionChartWidget: Widget = {
  id: "session-chart",
  title: "Session usage",
  icon: "ph-chart-line",
  scope: "account",
  half: true,
  dataDeps: ["usageHistory", "tokenHistory"],
  render: (root, ctx) => mountUsageWidget("session", "chart", root, ctx),
};

export const sessionBarsWidget: Widget = {
  id: "session-bars",
  title: "Session by project",
  icon: "ph-chart-bar",
  scope: "account",
  half: true,
  dataDeps: ["usageHistory", "tokenHistory"],
  render: (root, ctx) => mountUsageWidget("session", "bars", root, ctx),
};

export const weeklyChartWidget: Widget = {
  id: "weekly-chart",
  title: "Weekly session usage",
  icon: "ph-chart-line-up",
  scope: "account",
  half: true,
  dataDeps: ["usageHistory", "tokenHistory"],
  render: (root, ctx) => mountUsageWidget("weekly", "chart", root, ctx),
};

export const weeklyBarsWidget: Widget = {
  id: "weekly-bars",
  title: "Weekly by project",
  icon: "ph-chart-bar-horizontal",
  scope: "account",
  half: true,
  dataDeps: ["usageHistory", "tokenHistory"],
  render: (root, ctx) => mountUsageWidget("weekly", "bars", root, ctx),
};
