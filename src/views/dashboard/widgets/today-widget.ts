// Global dashboard widget: "Today across all projects" (moved from the
// deleted src/views/statistics/statistics.ts, multi-account milestone 05).
// Global scope: ignores the selected account - token/project history isn't
// split per account in this milestone.

import { getTokenHistory } from "../../../shared/state";
import { totalTok } from "../../../shared/tokens";
import { buildProjectListHTML, wireProjectListClicks, isBlackRef, type ListProject } from "./project-list";
import type { Widget } from "./types";

function buildTodayHTML(): string {
  const tokenHistory = getTokenHistory();
  if (!tokenHistory || !tokenHistory.length) {
    return `<div class="v-empty">
      <i class="ph ph-calendar-dot v-empty-icon"></i>
      <div class="v-empty-title">No activity yet today</div>
      <div class="v-empty-hint">Token usage appears here once you work in a project today.</div>
    </div>`;
  }
  const today = new Date().toISOString().slice(0, 10);
  const todayRecords = tokenHistory.filter((r) => r.date === today);
  if (!todayRecords.length) {
    return `<div class="v-empty">
      <i class="ph ph-calendar-dot v-empty-icon"></i>
      <div class="v-empty-title">No activity yet today</div>
      <div class="v-empty-hint">Token usage appears here once you work in a project today.</div>
    </div>`;
  }

  const byProject = new Map<string, ListProject>();
  for (const r of todayRecords) {
    const key = r.cwd || "(unknown)";
    if (isBlackRef(key)) continue;
    let p = byProject.get(key);
    if (!p) {
      p = { cwd: key, tokens: 0, lastActiveAt: "" };
      byProject.set(key, p);
    }
    p.tokens += totalTok(r);
    const ts = r.lastActiveAt || r.recordedAt || r.date || "";
    if (ts > (p.lastActiveAt || "")) p.lastActiveAt = ts;
  }

  return buildProjectListHTML({
    projects: Array.from(byProject.values()),
    sortable: true,
    defaultSort: "lastActiveAt",
    id: "today-projects",
  }) || `<div class="v-empty">
    <i class="ph ph-calendar-dot v-empty-icon"></i>
    <div class="v-empty-title">No activity yet today</div>
    <div class="v-empty-hint">Token usage appears here once you work in a project today.</div>
  </div>`;
}

export const todayWidget: Widget = {
  id: "today",
  title: "Today across all projects",
  icon: "ph-calendar-dot",
  scope: "global",
  dataDeps: ["tokenHistory"],
  render: (root) => {
    const redraw = () => {
      root.innerHTML = buildTodayHTML();
      wireProjectListClicks(root, redraw);
    };
    redraw();
  },
};
