import { html, render } from "lit-html";
import { getProjectDetailState } from "../../../../shared/state";
import { api } from "../../../../shared/api";
import { backFromSubview } from "../../../../shared/navigation";
import { renderWhitelistEditor } from "../../../../shared/whitelist-editor";
import { projectSubviewHeaderData, subviewHeaderTemplate, hydrateSubviewHeader } from "../../subview-header";
import type { Avatar } from "../../subview-header";
import "./character-pick.css";

function template(avatar: Avatar, title: string, projectPath?: string) {
  return html`
    <div class="view view-project-character-pick">
      <div class="view-header subview-header">
        ${subviewHeaderTemplate(avatar, title, () => backFromSubview(), projectPath)}
      </div>
      <div class="view-body">
        <p class="muted">Which characters can be randomly assigned to this project's sessions. Each session gets one, and you can change it per session. "Use default" inherits the global default from Settings.</p>
        <div id="whitelist-editor-host"></div>
      </div>
    </div>
  `;
}

export async function renderCharacterPickView(root: HTMLElement): Promise<() => void> {
  const { avatar, title, cwd: headerCwd } = projectSubviewHeaderData();
  render(template(avatar, title, headerCwd), root);
  void hydrateSubviewHeader(root);

  const cwd = getProjectDetailState().cwd;
  if (!cwd) return () => { /* nothing */ };

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
