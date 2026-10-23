// The Projects tab's sidebar list: the open groups and projects, in the
// chats list's own portrait-row look. A separate ul from #sessions-list because
// renderSidebar reconciles that one wholesale.
import { html, nothing, render, type TemplateResult } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import { hydrateProjectTechIcons, renderAvatar } from "../../../shared/projects";
import { getSettings } from "../../../shared/state";
import { listDotClass, listSubline, sameCwd, sameRef } from "./format";
import type { DashboardTargetRef, ListRow } from "./types";

/** A row is open unless the daemon says otherwise (an older daemon sends no flag). */
export const isOpen = (r: ListRow): boolean => r.open !== false;

function face(row: ListRow): TemplateResult {
  if (row.target.kind === "group") return html`<i class="ph ph-briefcase"></i>`;
  const cwd = row.target.repos[0]?.cwd;
  const avatar = getSettings()?.projects?.find((p) => cwd && sameCwd(p.path, cwd))?.avatar;
  return html`${unsafeHTML(renderAvatar(avatar, cwd))}`;
}

function rowTemplate(row: ListRow, active: boolean, nowMs: number, h: ListHandlers): TemplateResult {
  const ref: DashboardTargetRef = { kind: row.target.kind, id: row.target.id };
  const dot = listDotClass(row);
  return html`<li class="row-portrait ${active ? "active" : ""}" data-pd-row=${`${ref.kind}:${ref.id}`} @click=${() => h.pick(ref)}>
    <span class="session-avatar-wrap">
      <span class="session-avatar session-avatar--placeholder">${face(row)}</span>
      ${dot ? html`<span class="avatar-status-dot ${dot}"></span>` : nothing}
    </span>
    <div class="session-row-text is-two-line">
      <span class="session-row-title"><span class="session-row-title-text">${row.target.name}</span></span>
      <span class="session-row-project"><span class="proj-name">${listSubline(row, nowMs)}</span></span>
    </div>
    <button type="button" class="pd-row-x" title="Close project" aria-label="Close project"
      @click=${(e: Event) => { e.stopPropagation(); h.close(ref); }}><i class="ph ph-x"></i></button>
  </li>`;
}

export interface ListHandlers {
  pick(r: DashboardTargetRef): void;
  /** Hide the project from this list (it stays openable from the + picker). */
  close(r: DashboardTargetRef): void;
  /** Open the picker of closed projects. */
  add(): void;
}

export function renderProjectsList(ul: HTMLElement, rows: ListRow[], selected: DashboardTargetRef | null, h: ListHandlers): void {
  const now = Date.now();
  const open = rows.filter(isOpen);
  render(html`
    <li class="session-group-header pd-list-head"><span>Open projects</span>
      <button type="button" class="pd-list-add" title="Open a project" aria-label="Open a project"
        @click=${() => h.add()}><i class="ph ph-plus"></i></button></li>
    ${open.length === 0
      ? html`<li class="session-group-header pd-list-empty">${rows.length ? "No open projects" : "No projects yet"}</li>`
      : open.map((r) => rowTemplate(r, sameRef(selected, { kind: r.target.kind, id: r.target.id }), now, h))}
  `, ul);
  void hydrateProjectTechIcons(ul);
}
