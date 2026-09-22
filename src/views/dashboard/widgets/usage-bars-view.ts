// Project bars view (alt render mode for the session/weekly usage widgets)
// and its "show N more" wiring. Split out of usage-charts.ts, see
// .for_bepy/ai_todos/177-split-usage-charts-widget-file.md.

import { getTokenHistory } from "../../../shared/state";
import type { TokenRecord } from "../../../shared/tokens";
import { formatTokens, totalTok } from "../../../shared/tokens";
import { hourToMs } from "../../../shared/time";
import { plabel, type ListProject } from "./project-list";
import type { UsageRecord } from "../../../shared/api";

type Wired = Element & { _wired?: boolean };
function wired(el: Element): Wired { return el as Wired; }

const BAR_COLORS = ["#9d7dfc", "#6e8fff", "#7af0c0", "#e67e22", "#e74c3c"];

export function buildProjectBarsView(
  startMs: number, endMs: number,
  usageHistory: UsageRecord[] | undefined,
  pctKey: "s" | "w",
  maxItems: number | null,
  listId: string | null,
): string {
  const tokenHistory = getTokenHistory();
  if (!tokenHistory || !tokenHistory.length) {
    return `<div class="v-empty">
      <i class="ph ph-chart-bar-horizontal v-empty-icon"></i>
      <div class="v-empty-title">No project data yet</div>
      <div class="v-empty-hint">Bars appear once token history is recorded.</div>
    </div>`;
  }

  const byProject = new Map<string, ListProject>();
  for (const r of tokenHistory) {
    const endTs = r.lastActiveAt || "";
    const startTs = (r as TokenRecord & { startedAt?: string }).startedAt || "";
    if (!endTs) continue;
    const sessionEndMs = new Date(endTs).getTime();
    if (isNaN(sessionEndMs)) continue;
    if (startTs) {
      const sessionStartMs = new Date(startTs).getTime();
      if (isNaN(sessionStartMs)) continue;
      if (sessionStartMs >= endMs || sessionEndMs <= startMs) continue;
    } else {
      if (sessionEndMs < startMs || sessionEndMs > endMs) continue;
    }
    const key = r.cwd || "(unknown)";
    let p = byProject.get(key);
    if (!p) {
      p = { cwd: key, tokens: 0 };
      byProject.set(key, p);
    }
    p.tokens += totalTok(r);
  }

  const projects = Array.from(byProject.values()).sort((a, b) => b.tokens - a.tokens);
  if (!projects.length) {
    return `<div class="v-empty">
      <i class="ph ph-chart-bar-horizontal v-empty-icon"></i>
      <div class="v-empty-title">No projects in this window</div>
      <div class="v-empty-hint">Try paging to a different session or week.</div>
    </div>`;
  }

  const pctField = pctKey === "w" ? "weekly_pct" : "session_pct";
  let totalPct: number | null = null;
  if (usageHistory && usageHistory.length) {
    const windowPts = usageHistory
      .filter((r) => (r as Record<string, unknown>)[pctField] != null)
      .map((r) => ({ t: hourToMs(r.hour), pct: (r as Record<string, number>)[pctField] as number }))
      .filter((p) => p.t >= startMs && p.t <= endMs)
      .sort((a, b) => a.t - b.t);
    if (windowPts.length >= 2) {
      const first = windowPts[0]!;
      const last = windowPts[windowPts.length - 1]!;
      totalPct = last.pct - first.pct;
      if (totalPct <= 0) totalPct = null;
    }
  }

  const totalTokens = projects.reduce((s, p) => s + p.tokens, 0);
  const maxTokens = projects[0]!.tokens;

  const top = maxItems ? projects.slice(0, maxItems) : projects;
  const rest = maxItems ? projects.slice(maxItems) : [];
  const otherTokens = rest.reduce((s, p) => s + p.tokens, 0);

  const rows: string[] = top.map((p, i) => {
    const pct = totalPct !== null ? Math.round((p.tokens / totalTokens) * totalPct) : null;
    const barWidth = Math.max(2, Math.round((p.tokens / maxTokens) * 100));
    const color = BAR_COLORS[i % BAR_COLORS.length];
    return `<div class="project-bar-row">
      <span class="project-bar-label" title="${p.cwd}">${plabel(p.cwd)}</span>
      <div class="project-bar-track">
        <div class="project-bar-fill" style="width:${barWidth}%;background:${color}"></div>
      </div>
      <span class="project-bar-value">${pct !== null ? pct + "%" : formatTokens(p.tokens)}</span>
    </div>`;
  });

  if (otherTokens > 0) {
    const pct = totalPct !== null ? Math.round((otherTokens / totalTokens) * totalPct) : null;
    const barWidth = Math.max(2, Math.round((otherTokens / maxTokens) * 100));
    rows.push(`<div class="project-bar-row">
      <span class="project-bar-label" style="color:var(--sb-muted)">Other</span>
      <div class="project-bar-track">
        <div class="project-bar-fill" style="width:${barWidth}%;background:var(--sb-muted)"></div>
      </div>
      <span class="project-bar-value">${pct !== null ? pct + "%" : formatTokens(otherTokens)}</span>
    </div>`);
    if (listId) {
      rows.push(`<div class="project-bars-more" data-bars-list-id="${listId}">Show ${rest.length} more</div>`);
    }
  }

  const totalLabel = totalPct !== null ? `Total: ${totalPct}%` : `Total: ${formatTokens(totalTokens)} tokens`;
  return `<div class="project-bars">
    ${rows.join("")}
    <div class="project-bars-total">${totalLabel}</div>
  </div>`;
}

export function wireBarsMore(container: HTMLElement | null, onShowMore: (listId: string) => void): void {
  if (!container) return;
  container.querySelectorAll<HTMLElement>(".project-bars-more").forEach((link) => {
    const w = wired(link);
    if (w._wired) return;
    w._wired = true;
    link.onclick = () => {
      const listId = link.dataset["barsListId"];
      if (listId) onShowMore(listId);
    };
  });
}
