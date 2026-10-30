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
  form.style.display = "block";
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

/** Fills a popup body with the project's settings (account, connectors,
 *  gaming mode, tickets, automation). */
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

function template() {
  return html`
    <div class="view-project-automation">
        <section class="automation-section" id="chatDefaultsSection" style="margin-top:0">
          <div class="section-title">New chat defaults</div>
          <div class="option">
            <span class="oi"><div class="option-label">Model</div></span>
            <span class="acc-row-control" id="chatDefaultModelControl"></span>
          </div>
          <div class="option">
            <span class="oi"><div class="option-label">Effort</div></span>
            <span class="acc-row-control" id="chatDefaultEffortControl"></span>
          </div>
        </section>
        <section class="automation-section" id="accountSection" style="margin-top:16px">
          <div class="section-title">Claude account</div>
          <div class="option">
            <span class="oi">
              <div class="option-label">Which account new chats in this project use</div>
            </span>
            <span class="acc-row-control" id="automationAccountControl"></span>
          </div>
        </section>
        <section class="automation-section" id="connectorsSection" style="margin-top:16px">
          <div class="section-title">Connectors</div>
          <div class="option">
            <span class="oi">
              <div class="option-label">Use your claude.ai connectors (Google Drive etc.) in this project's chats</div>
            </span>
            <label class="switch"><input type="checkbox" id="connectorsEnabled"><span class="slider"></span></label>
          </div>
        </section>
        <section class="automation-section" id="gamingModeSection" style="margin-top:16px">
          <div class="section-title">Gaming mode</div>
          <div class="option">
            <span class="oi">
              <div class="option-label">Keep running in gaming mode</div>
            </span>
            <label class="switch"><input type="checkbox" id="gamingModeKeepRunning"><span class="slider"></span></label>
          </div>
        </section>
        <section class="automation-section" id="trackerSection" style="margin-top:16px">
          <div class="section-title">Tickets</div>
          <div class="option">
            <span class="oi">
              <div class="option-label">Where this project's tickets live, so ticket ids in chat link to them</div>
            </span>
            <span class="acc-row-control" id="trackerControl"></span>
          </div>
        </section>
        <section class="automation-section" id="automationSection" style="margin-top:16px">
          <div class="section-title">Automation</div>
          <div id="automationEmpty" class="v-empty">
            <i class="ph ph-robot v-empty-icon"></i>
            <div class="v-empty-title">No automation configured</div>
            <div class="v-empty-hint">Have this project's Claude Code session start at boot and stay alive.</div>
            <button class="automate-cta" id="automateChannelBtn">+ Automate channel</button>
          </div>
          <div id="automationForm" style="display:none">
            <div class="option">
              <span class="option-label">Enabled</span>
              <label class="switch"><input type="checkbox" id="automationEnabled"><span class="slider"></span></label>
            </div>
            <div class="option">
              <span class="option-label">Start on boot</span>
              <label class="switch"><input type="checkbox" id="automationAutostart"><span class="slider"></span></label>
            </div>
            <div class="option">
              <span class="option-label">Continue previous session (<code>--continue</code>)</span>
              <label class="switch"><input type="checkbox" id="automationContinue"><span class="slider"></span></label>
            </div>
            <div class="option">
              <span class="option-label">Session name prefix</span>
              <input type="text" id="automationPrefix" class="inline-input" placeholder="(uses project name)">
            </div>
            <div style="display:flex;gap:6px;margin-top:8px">
              <button class="btn-secondary" id="automationRemoveBtn">Remove automation</button>
              <div style="flex:1"></div>
              <button class="btn-primary" id="automationApplyBtn">Apply</button>
            </div>
          </div>
        </section>
    </div>
  `;
}
