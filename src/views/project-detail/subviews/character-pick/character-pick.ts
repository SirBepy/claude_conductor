import { html, render } from "lit-html";
import { renderAvatar, hydrateCharacterAvatars, hydrateProjectTechIcons, projectLabel } from "../../../../shared/projects";
import { getProjectDetailState, getSettings } from "../../../../shared/state";
import { api } from "../../../../shared/api";
import { backFromSubview } from "../../../../shared/navigation";
import { renderWhitelistEditor } from "../../../../shared/whitelist-editor";
import "./character-pick.css";

function template() {
  return html`
    <div class="view view-project-character-pick">
      <div class="view-header">
        <button class="icon-btn" id="characterPickBackBtn" title="Back"><i class="ph ph-arrow-left"></i></button>
        <div style="display:flex;align-items:center;gap:8px;flex:1">
          <div class="avatar-mini" id="characterPickAvatar">?</div>
          <h2 id="characterPickTitle" style="font-size:0.88rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Character whitelist</h2>
        </div>
        <div class="subview-header-spacer"></div>
      </div>
      <div class="view-body">
        <p class="muted">Which characters can be randomly assigned to this project's sessions. Each session gets one, and you can change it per session. "Use default" inherits the global default from Settings.</p>
        <div id="whitelist-editor-host"></div>
      </div>
    </div>
  `;
}

export async function renderCharacterPickView(root: HTMLElement): Promise<() => void> {
  render(template(), root);

  const back = root.querySelector<HTMLButtonElement>("#characterPickBackBtn");
  if (back) back.onclick = () => backFromSubview();

  const cwd = getProjectDetailState().cwd;
  if (!cwd) return () => { /* nothing */ };

  // Populate header
  const settings = getSettings();
  const configured = (settings.projects || []).find((p) => p.path === cwd);
  // No custom avatar -> hydratable project-face placeholder (icon -> tech logo
  // -> folder), consistent with the projects list (ai_todo 114).
  const avatar = configured?.avatar || { kind: "none" as const };
  const aliases = settings.projectAliases || {};

  const titleEl = root.querySelector<HTMLElement>("#characterPickTitle");
  if (titleEl) titleEl.textContent = projectLabel(cwd, aliases);

  const avatarEl = root.querySelector<HTMLElement>("#characterPickAvatar");
  if (avatarEl) {
    avatarEl.innerHTML = renderAvatar(avatar, cwd);
    if (avatar.kind === "character") {
      void hydrateCharacterAvatars(avatarEl);
    }
    void hydrateProjectTechIcons(avatarEl);
  }

  const host = root.querySelector<HTMLElement>("#whitelist-editor-host");
  if (!host) return () => { /* nothing */ };

  // Resolve the backend project id from the cwd, then mount the editor.
  const projects = (await api.listProjects()) as unknown as Array<{ id: string; path: string }>;
  const proj = projects.find((p) => p.path === cwd);
  if (!proj) {
    host.innerHTML = `<p class="muted">Project not found.</p>`;
    return () => { /* nothing */ };
  }

  const current = await api.getProjectWhitelist(proj.id);
  await renderWhitelistEditor(host, {
    value: current,
    allowDefault: true,
    onChange: (wl) => {
      void api.setProjectWhitelist(proj.id, wl).catch((e) => {
        console.error("[character-pick] setProjectWhitelist failed", e);
      });
    },
  });

  return () => { /* nothing to tear down */ };
}
