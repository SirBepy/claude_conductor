import { html, render, type TemplateResult } from "lit-html";
import { api } from "../../shared/api";
import type { SkillDetail, SkillUsageEvent } from "../../types/ipc.generated";
import { showView } from "../../shared/navigation";
import { tokensAllIn } from "../../shared/tokens";
import { buildPieSvg } from "../../shared/pie";
import "./skill-detail.css";

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
            <div class="skill-detail empty">No skill selected.</div>
          </div>
        </div>
      `,
      root,
    );
    return () => { /* noop */ };
  }

  const draw = (detail: SkillDetail | null) => {
    if (!detail) {
      render(html`<div class="skill-detail loading">Loading&hellip;</div>`, root);
      return;
    }
    render(buildView(detail), root);
  };

  draw(null);
  const detail = await api.getSkillUsageDetail(skill);
  draw(detail);

  const unlisten = api.onSkillUsageChanged(() => {
    void api.getSkillUsageDetail(skill).then(draw);
  });

  return () => {
    try { unlisten(); } catch { /* ignore */ }
  };
}

function buildView(d: SkillDetail): TemplateResult {
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
