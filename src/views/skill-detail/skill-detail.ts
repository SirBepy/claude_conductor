import { html, render, type TemplateResult } from "lit-html";
import { api } from "../../shared/api";
import type { InstalledSkill, SkillDetail, SkillUsageEvent } from "../../types/ipc.generated";
import { showView } from "../../shared/navigation";
import { tokensAllIn } from "../../shared/tokens";
import { buildPieSvg } from "../../shared/pie";
import { readScopes, saveScope, scopeEditor, type ScopeMap, type ScopeProject, type SkillScope } from "./scope-editor";
import "./skill-detail.css";

interface ScopeState {
  skill: InstalledSkill | null;
  projects: ScopeProject[];
  scopes: ScopeMap;
  addOpen: boolean;
}

const SOURCE_COLORS = {
  manual: "var(--color-info)",
  skill: "var(--color-primary)",
  auto: "var(--sb-muted)",
} as const;

function targetSkill(): string {
  return (window as unknown as { skillDetailTarget?: string }).skillDetailTarget ?? "";
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return ts;
  }
}

export async function renderSkillDetailView(root: HTMLElement): Promise<() => void> {
  const skill = targetSkill();
  if (!skill) {
    render(
      html`
        <div class="view view-skill-detail">
          <div class="view-header">
            <button class="icon-btn" title="Back" @click=${() => showView("skills")}>
              <i class="ph ph-arrow-left"></i>
            </button>
            <h2>Skill</h2>
            <div style="width:32px"></div>
          </div>
          <div class="view-body">
            <div class="view-body-inner">
              <div class="skill-detail empty">No skill selected.</div>
            </div>
          </div>
        </div>
      `,
      root,
    );
    return () => { /* noop */ };
  }

  let detail: SkillDetail | null = null;
  const scope: ScopeState = { skill: null, projects: [], scopes: {}, addOpen: false };
  const draw = () => {
    if (!detail) {
      render(html`<div class="skill-detail loading">Loading&hellip;</div>`, root);
      return;
    }
    render(buildView(detail, scopeSection(scope, draw)), root);
  };
  const closeMenu = () => {
    if (!scope.addOpen) return;
    scope.addOpen = false;
    draw();
  };
  document.addEventListener("click", closeMenu);

  draw();
  const [d, installed, projects, settings] = await Promise.all([
    api.getSkillUsageDetail(skill),
    api.listInstalledSkills().catch(() => [] as InstalledSkill[]),
    api.listProjects().catch(() => [] as ScopeProject[]),
    api.getSettings().catch(() => null),
  ]);
  detail = d;
  scope.skill = installed.find((s) => s.skill === skill) ?? null;
  scope.projects = projects;
  scope.scopes = readScopes(settings);
  draw();

  const unlisten = api.onSkillUsageChanged(() => {
    void api.getSkillUsageDetail(skill).then((next) => {
      detail = next;
      draw();
    });
  });

  return () => {
    document.removeEventListener("click", closeMenu);
    try { unlisten(); } catch { /* ignore */ }
  };
}

function scopeSection(s: ScopeState, redraw: () => void): TemplateResult {
  const key = s.skill?.scope_key;
  if (!s.skill || !key) return html``;
  return scopeEditor({
    skill: s.skill,
    scope: s.scopes[key] ?? null,
    projects: s.projects,
    addOpen: s.addOpen,
    onToggleAdd: () => {
      s.addOpen = !s.addOpen;
      redraw();
    },
    onChange: (next: SkillScope | null) => {
      s.addOpen = false;
      // Optimistic, so the click lands at once; the save's own result wins.
      const prev = s.scopes;
      s.scopes = { ...prev };
      if (next) s.scopes[key] = next;
      else delete s.scopes[key];
      redraw();
      saveScope(key, next).then(
        (saved) => {
          s.scopes = saved;
          redraw();
        },
        (err) => {
          console.error("[skill-detail] saving the scope failed", err);
          s.scopes = prev;
          redraw();
        },
      );
    },
  });
}

function buildView(d: SkillDetail, scope: TemplateResult): TemplateResult {
  return html`
    <div class="view view-skill-detail">
      <div class="view-header">
        <button class="icon-btn" title="Back" @click=${() => showView("skills")}>
          <i class="ph ph-arrow-left"></i>
        </button>
        <h2>${d.skill}</h2>
        <div style="width:32px"></div>
      </div>
      <div class="view-body">
        <div class="view-body-inner">
          ${scope}
          <div class="counters">
            ${counter("Total", d.invocations.total)}
            ${counter("Manual", d.invocations.manual)}
            ${counter("Skill-chained", d.invocations.skill)}
            ${counter("Auto", d.invocations.auto)}
          </div>
          ${sourcePie(d)}
          ${d.events.length === 0
            ? html`<div class="empty">No invocations recorded for this skill in the last 7 days.</div>`
            : html`
              <table class="invocations">
                <thead>
                  <tr><th>Time</th><th>Project</th><th>Tokens</th><th>Source</th></tr>
                </thead>
                <tbody>
                  ${d.events.map(eventRow)}
                </tbody>
              </table>
            `}
        </div>
      </div>
    </div>
  `;
}

function counter(label: string, value: number): TemplateResult {
  return html`<div class="counter"><div class="value">${value}</div><div class="label">${label}</div></div>`;
}

function sourcePie(d: SkillDetail): TemplateResult {
  const total = d.invocations.total;
  if (total === 0) return html``;
  const rows: { label: string; n: number; color: string }[] = [
    { label: "Manual", n: d.invocations.manual, color: SOURCE_COLORS.manual },
    { label: "Skill", n: d.invocations.skill, color: SOURCE_COLORS.skill },
    { label: "Auto", n: d.invocations.auto, color: SOURCE_COLORS.auto },
  ].filter((r) => r.n > 0);
  const slices = rows.map((r) => ({ value: r.n, color: r.color }));
  const wrap = document.createElement("div");
  wrap.innerHTML = buildPieSvg(slices, total, { r: 50, cx: 60, cy: 60, size: 120 });
  return html`<div class="source-pie">${wrap}</div>`;
}

function eventRow(e: SkillUsageEvent): TemplateResult {
  return html`
    <tr>
      <td>${formatTime(e.ts)}</td>
      <td>${e.project}</td>
      <td>${tokensAllIn(e.tokens).toLocaleString()}</td>
      <td><span class="badge badge-${e.source}">${e.source}</span></td>
    </tr>
  `;
}
