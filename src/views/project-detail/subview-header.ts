import { html } from "lit-html";
import type { TemplateResult } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import type { Avatar } from "../../shared/projects";
import { renderAvatar, hydrateCharacterAvatars, hydrateProjectTechIcons, projectLabel } from "../../shared/projects";
import { getProjectDetailState, getSettings } from "../../shared/state";

export type { Avatar };

export function projectSubviewHeaderData(): { avatar: Avatar; title: string; cwd: string } {
  const cwd = getProjectDetailState().cwd || "";
  const settings = getSettings();
  const configured = (settings.projects || []).find((p: { path: string }) => p.path === cwd);
  // No custom avatar -> render the hydratable project-face placeholder (icon ->
  // tech logo -> folder), consistent with the projects list (ai_todo 99/114),
  // instead of the old first-letter pseudo-emoji.
  const avatar: Avatar = (configured?.avatar as Avatar) || { kind: "none" };
  const aliases = settings.projectAliases || {};
  return { avatar, title: projectLabel(cwd, aliases), cwd };
}

export function subviewHeaderTemplate(
  avatar: Avatar,
  title: string,
  onBack: () => void,
  projectPath?: string,
): TemplateResult {
  return html`
    <button class="icon-btn" title="Back" @click=${onBack}><i class="ph ph-arrow-left"></i></button>
    <div class="project-detail-heading">
      <div class="avatar-mini">${unsafeHTML(renderAvatar(avatar, projectPath))}</div>
      <div class="project-detail-titles">
        <h2 style="font-size:0.88rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${title}</h2>
      </div>
    </div>
    <div class="subview-header-spacer"></div>
  `;
}

export async function hydrateSubviewHeader(root: HTMLElement): Promise<void> {
  const avatarEl = root.querySelector<HTMLElement>(".subview-header .avatar-mini");
  if (avatarEl) {
    await hydrateCharacterAvatars(avatarEl);
    await hydrateProjectTechIcons(avatarEl);
  }
}
