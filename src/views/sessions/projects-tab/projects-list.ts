// The Projects tab's sidebar list: "Recently used" groups and projects, in the
// chats list's own portrait-row look. A separate ul from #sessions-list because
// renderSidebar reconciles that one wholesale.
import { html, nothing, render, type TemplateResult } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import { hydrateProjectTechIcons, renderAvatar } from "../../../shared/projects";
import { getSettings } from "../../../shared/state";
import { listDotClass, listSubline, sameCwd, sameRef } from "./format";
import type { DashboardListRow, DashboardTargetRef } from "./types";

function face(row: DashboardListRow): TemplateResult {
  if (row.target.kind === "group") return html`<i class="ph ph-briefcase"></i>`;
  const cwd = row.target.repos[0]?.cwd;
  const avatar = getSettings()?.projects?.find((p) => cwd && sameCwd(p.path, cwd))?.avatar;
  return html`${unsafeHTML(renderAvatar(avatar, cwd))}`;
}

function rowTemplate(row: DashboardListRow, active: boolean, nowMs: number, onPick: (r: DashboardTargetRef) => void): TemplateResult {
  const ref: DashboardTargetRef = { kind: row.target.kind, id: row.target.id };
  const dot = listDotClass(row);
  return html`<li class="row-portrait ${active ? "active" : ""}" data-pd-row=${`${ref.kind}:${ref.id}`} @click=${() => onPick(ref)}>
    <span class="session-avatar-wrap">
      <span class="session-avatar session-avatar--placeholder">${face(row)}</span>
      ${dot ? html`<span class="avatar-status-dot ${dot}"></span>` : nothing}
    </span>
    <div class="session-row-text is-two-line">
      <span class="session-row-title"><span class="session-row-title-text">${row.target.name}</span></span>
      <span class="session-row-project"><span class="proj-name">${listSubline(row, nowMs)}</span></span>
    </div>
  </li>`;
}

export function renderProjectsList(
  ul: HTMLElement,
  rows: DashboardListRow[],
  selected: DashboardTargetRef | null,
  onPick: (r: DashboardTargetRef) => void,
): void {
  const now = Date.now();
  render(html`
    <li class="session-group-header">Recently used</li>
    ${rows.length === 0
      ? html`<li class="session-group-header pd-list-empty">No projects yet</li>`
      : rows.map((r) => rowTemplate(r, sameRef(selected, { kind: r.target.kind, id: r.target.id }), now, onPick))}
  `, ul);
  void hydrateProjectTechIcons(ul);
}
