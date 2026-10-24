import { html, render } from "lit-html";
import { api } from "../../../../shared/api";
import { renderWhitelistEditor } from "../../../../shared/whitelist-editor";
import "./character-pick.css";

function template() {
  return html`
    <div class="view-project-character-pick">
      <p class="muted">Which characters can be randomly assigned to this project's sessions. Each session gets one, and you can change it per session. "Use default" inherits the global default from Settings.</p>
      <div id="whitelist-editor-host"></div>
    </div>
  `;
}

/** Fills a popup body with the project's character whitelist editor; each change saves at once. */
export async function renderCharacterPick(root: HTMLElement, cwd: string): Promise<void> {
  render(template(), root);

  const host = root.querySelector<HTMLElement>("#whitelist-editor-host");
  if (!host) return;

  // Resolve the backend project id from the cwd, then mount the editor.
  const projects = (await api.listProjects()) as unknown as Array<{ id: string; path: string }>;
  const proj = projects.find((p) => p.path === cwd);
  if (!proj) {
    host.innerHTML = `<p class="muted">Project not found.</p>`;
    return;
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
}
