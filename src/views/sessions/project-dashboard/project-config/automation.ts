import { html, render } from "lit-html";
import { showToast } from "../../../../shared/toast";
import { api } from "../../../../shared/api";
import { renderChatDefaultsRow } from "./chat-defaults-row";
import type { ProjectCfg } from "./project-cfg";
import { renderAccountRow, renderConnectorsRow, renderGamingModeRow, renderTrackerRow } from "./rows";
import "./automation.css";

async function renderAutomationForm(cwd: string): Promise<void> {
  if (!cwd) return;
  const projects = (await api.listProjects()) as unknown as ProjectCfg[];
  const proj = projects.find((p) => p.path === cwd);
  const empty = document.getElementById("automationEmpty") as HTMLElement | null;
  const form = document.getElementById("automationForm") as HTMLElement | null;
  if (!empty || !form) return;
  if (!proj || !proj.automation) {
    empty.style.display = "";
    form.style.display = "none";
    return;
  }
  empty.style.display = "none";
  form.style.display = "";
  const enabled = document.getElementById("automationEnabled") as HTMLInputElement | null;
  const autostart = document.getElementById("automationAutostart") as HTMLInputElement | null;
  const cont = document.getElementById("automationContinue") as HTMLInputElement | null;
  const prefix = document.getElementById("automationPrefix") as HTMLInputElement | null;
  if (enabled) enabled.checked = !!proj.automation.enabled;
  if (autostart) autostart.checked = !!proj.automation.autostart_on_boot;
  if (cont) cont.checked = !!proj.automation.continue_flag;
  if (prefix) prefix.value = proj.automation.session_name_prefix || "";
  form.dataset.projectId = proj.id;
}

/** Fills a popup body with the project's settings (model and effort, account,
 *  tickets, connectors, gaming mode, automation). */
export async function renderProjectSettings(root: HTMLElement, cwd: string): Promise<void> {
  render(template(), root);

  const automate = root.querySelector<HTMLButtonElement>("#automateChannelBtn");
  if (automate) {
    automate.onclick = async () => {
      if (!cwd) return;
      let proj: ProjectCfg;
      try { proj = (await api.ensureProject(cwd)) as unknown as ProjectCfg; }
      catch (e) { return showToast(`Could not register project: ${e}`); }
      await api.updateProject(proj.id, {
        automation: {
          enabled: false,
          autostart_on_boot: true,
          session_name_prefix: null,
          continue_flag: true,
        },
      });
      await renderAutomationForm(cwd);
      showToast("Automation added. Flip Enabled to start it.");
    };
  }

  const applyBtn = root.querySelector<HTMLButtonElement>("#automationApplyBtn");
  if (applyBtn) {
    applyBtn.onclick = async () => {
      const form = document.getElementById("automationForm") as HTMLElement | null;
      const projectId = form?.dataset.projectId;
      if (!projectId) return;
      const enabled = (document.getElementById("automationEnabled") as HTMLInputElement).checked;
      const autostart = (document.getElementById("automationAutostart") as HTMLInputElement).checked;
      const cont = (document.getElementById("automationContinue") as HTMLInputElement).checked;
      const prefix = (document.getElementById("automationPrefix") as HTMLInputElement).value.trim() || null;
      await api.updateProject(projectId, {
        automation: {
          enabled, autostart_on_boot: autostart,
          session_name_prefix: prefix, continue_flag: cont,
        },
      });
      if (enabled) {
        try { await api.spawnChannel(projectId); }
        catch (e) { showToast(`Spawn failed: ${e}`); }
      } else {
        try { await api.stopChannel(projectId); } catch { /* ignore */ }
      }
      showToast("Automation updated.");
    };
  }

  const removeBtn = root.querySelector<HTMLButtonElement>("#automationRemoveBtn");
  if (removeBtn) {
    removeBtn.onclick = async () => {
      const form = document.getElementById("automationForm") as HTMLElement | null;
      const projectId = form?.dataset.projectId;
      if (!projectId) return;
      try { await api.stopChannel(projectId); } catch { /* ignore */ }
      await api.updateProject(projectId, { automation: null });
      await renderAutomationForm(cwd);
      showToast("Automation removed.");
    };
  }

  await renderAutomationForm(cwd);
  await renderChatDefaultsRow(cwd);
  await renderAccountRow(cwd);
  await renderConnectorsRow(cwd);
  await renderGamingModeRow(cwd);
  await renderTrackerRow(cwd);
}

// A short label with the explanation on hover: the rail is 270px wide, so a
// sentence per row would stack taller than the settings themselves.
function template() {
  const toggle = (id: string) => html`<label class="switch"><input type="checkbox" id=${id}><span class="slider"></span></label>`;
  return html`
    <div class="view-project-automation">
      <div class="ps-group">
        <div class="ps-field">
          <div class="ps-label" title="The model new chats in this project open on">Model</div>
          <div id="chatDefaultModelControl"></div>
        </div>
        <div class="ps-field">
          <div class="ps-label" title="The effort new chats in this project open on">Effort</div>
          <div id="chatDefaultEffortControl"></div>
        </div>
        <div class="ps-field">
          <div class="ps-label" title="Which Claude account new chats in this project use">Account</div>
          <span class="acc-row-control" id="automationAccountControl"></span>
        </div>
        <div class="ps-field">
          <div class="ps-label" title="Where this project's tickets live, so ticket ids in chat link to them">Tickets</div>
          <span class="acc-row-control" id="trackerControl"></span>
        </div>
      </div>
      <div class="ps-group">
        <div class="ps-line">
          <span class="ps-label" title="Use your claude.ai connectors (Google Drive etc.) in this project's chats">Connectors</span>
          ${toggle("connectorsEnabled")}
        </div>
        <div class="ps-line">
          <span class="ps-label" title="Chats and dev servers here are not parked while gaming mode is on">Run in gaming mode</span>
          ${toggle("gamingModeKeepRunning")}
        </div>
        <div id="automationEmpty" class="ps-line">
          <span class="ps-label" title="Start this project's Claude Code session at boot and keep it alive">Automation</span>
          <button type="button" class="ps-btn" id="automateChannelBtn">+ Add</button>
        </div>
        <div id="automationForm" class="ps-sub" style="display:none">
          <div class="ps-label" title="Start this project's Claude Code session at boot and keep it alive">Automation</div>
          <div class="ps-line">
            <span class="ps-label">Enabled</span>
            ${toggle("automationEnabled")}
          </div>
          <div class="ps-line">
            <span class="ps-label">Start on boot</span>
            ${toggle("automationAutostart")}
          </div>
          <div class="ps-line">
            <span class="ps-label" title="Resume the previous session with --continue">Continue last session</span>
            ${toggle("automationContinue")}
          </div>
          <input type="text" id="automationPrefix" class="inline-input" placeholder="Session name prefix" aria-label="Session name prefix">
          <div class="ps-actions">
            <button type="button" class="ps-btn" id="automationRemoveBtn">Remove</button>
            <button type="button" class="ps-btn ps-btn-primary" id="automationApplyBtn">Apply</button>
          </div>
        </div>
      </div>
    </div>
  `;
}
