// Global dashboard widgets: "Top skills" (horizontal bars, last 7 days) and
// "Skill runs per day". Both read the existing skill-usage commands; the
// skill name in a bar opens that skill's detail.

import { html, render } from "lit-html";
import { api } from "../../../shared/api";
import { openSkillDetail } from "../../../shared/open-skill-detail";
import type { SkillUsageEvent } from "../../../types/ipc.generated";
import {
  runsPerDay,
  skillsToFetch,
  topSkills,
  type DayBucket,
  type SkillBar,
} from "./skill-charts-logic";
import type { Widget } from "./types";
import "./skill-charts-widget.css";

function empty(title: string) {
  return html`
    <div class="v-empty">
      <i class="ph ph-chart-bar v-empty-icon"></i>
      <div class="v-empty-title">${title}</div>
    </div>
  `;
}

function drawTop(root: HTMLElement, bars: SkillBar[] | null): void {
  if (bars === null) {
    render(html`<div class="skill-chart loading">Loading&hellip;</div>`, root);
    return;
  }
  if (bars.length === 0) {
    render(empty("No skill runs this week"), root);
    return;
  }
  const max = Math.max(...bars.map((b) => b.runs));
  render(html`
    <ul class="skill-bars">
      ${bars.map((b) => html`
        <li class="skill-bar-row">
          <button type="button" class="skill-bar-name" title=${`Open ${b.skill}`} @click=${() => openSkillDetail(b.skill)}>${b.skill}</button>
          <span class="skill-bar-track"><span class="skill-bar-fill" style=${`width:${Math.max(4, Math.round((b.runs / max) * 100))}%`}></span></span>
          <span class="skill-bar-count">${b.runs}</span>
        </li>
      `)}
    </ul>
  `, root);
}

function drawDays(root: HTMLElement, days: DayBucket[] | null, truncated: boolean): void {
  if (days === null) {
    render(html`<div class="skill-chart loading">Loading&hellip;</div>`, root);
    return;
  }
  const max = Math.max(...days.map((d) => d.runs));
  if (max === 0) {
    render(empty("No skill runs this week"), root);
    return;
  }
  render(html`
    <div class="skill-days">
      ${days.map((d) => html`
        <div class="skill-day" title=${`${d.runs} run${d.runs === 1 ? "" : "s"}`}>
          <span class="skill-day-count">${d.runs || ""}</span>
          <span class="skill-day-plot"><span class="skill-day-bar" style=${`height:${d.runs === 0 ? 2 : Math.max(4, Math.round((d.runs / max) * 100))}%`}></span></span>
          <span class="skill-day-label">${d.label}</span>
        </div>
      `)}
    </div>
    ${truncated ? html`<div class="skill-days-note">Counts the most-used skills only.</div>` : ""}
  `, root);
}

export const skillTopWidget: Widget = {
  id: "skill-top",
  title: "Top skills",
  icon: "ph-ranking",
  scope: "global",
  half: true,
  dataDeps: ["skillUsage"],
  render: (root) => {
    let alive = true;
    const load = () => {
      // A failed read leaves the empty state instead of an unhandled rejection.
      void api.getSkillUsageWeek().then((w) => {
        if (alive && w) drawTop(root, topSkills(w.entries));
      }).catch((err) => console.error("getSkillUsageWeek failed", err));
    };
    drawTop(root, null);
    load();
    const unlisten = api.onSkillUsageChanged(load);
    return () => {
      alive = false;
      try { unlisten(); } catch { /* ignore */ }
    };
  },
};

export const skillRunsWidget: Widget = {
  id: "skill-runs",
  title: "Skill runs per day",
  icon: "ph-chart-bar",
  scope: "global",
  half: true,
  dataDeps: ["skillUsage"],
  render: (root) => {
    let alive = true;
    const load = async () => {
      const week = await api.getSkillUsageWeek();
      if (!week) return;
      const { skills, truncated } = skillsToFetch(week.entries);
      // The week summary has no timestamps; each skill's detail does.
      const details = await Promise.all(skills.map((s) => api.getSkillUsageDetail(s)));
      if (!alive) return;
      const events: SkillUsageEvent[] = details.flatMap((d) => d.events);
      drawDays(root, runsPerDay(events, new Date()), truncated);
    };
    // A failed read leaves the empty state instead of an unhandled rejection.
    const safeLoad = () => load().catch((err) => console.error("skill runs load failed", err));
    drawDays(root, null, false);
    void safeLoad();
    const unlisten = api.onSkillUsageChanged(() => void safeLoad());
    return () => {
      alive = false;
      try { unlisten(); } catch { /* ignore */ }
    };
  },
};
