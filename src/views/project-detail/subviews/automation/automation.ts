import { html, render } from "lit-html";
import { escapeHtml } from "../../../../shared/escape-html";
import { showToast } from "../../../../shared/toast";
import { backFromSubview } from "../../../../shared/navigation";
import { getProjectDetailState } from "../../../../shared/state";
import { projectSubviewHeaderData, subviewHeaderTemplate, hydrateSubviewHeader } from "../../subview-header";
import type { Avatar } from "../../subview-header";
import { api } from "../../../../shared/api";
import type { Account } from "../../../../shared/api";
import { accountIconBadgeHtml } from "../../../../shared/account-chip";
import { invoke } from "../../../../shared/ipc";
import { forgetTicketTracker } from "../../../../shared/chat/ticket-refs";
import type { TicketTracker, TrackerInfo } from "../../../../types/ipc.generated";
import "../../../../shared/account-chip.css";
import "./automation.css";

interface Automation {
  enabled?: boolean;
  autostart_on_boot?: boolean;
  continue_flag?: boolean;
  session_name_prefix?: string | null;
}

interface ProjectCfg {
  id: string;
  path: string;
  automation?: Automation | null;
  preferred_account_id?: string | null;
  claude_ai_connectors?: boolean;
  tracker?: TicketTracker | null;
}

/** Which account new chats in this project spawn under (multi-account
 * milestone 04): the project's own binding if set, else the global default,
 * shown here only as the "Default (X)" option label - not resolved to an id.
 * Independent of whether the project has automation configured, so it lives
 * outside the automationEmpty/automationForm toggle below. */
async function renderAccountRow(): Promise<void> {
  const cwd = getProjectDetailState().cwd;
  const control = document.getElementById("automationAccountControl");
  if (!cwd || !control) return;

  let accounts: Account[] = [];
  let projects: ProjectCfg[] = [];
  let defaultAccountId: string | null = null;
  try {
    [accounts, projects] = await Promise.all([
      api.listAccounts(),
      api.listProjects() as unknown as Promise<ProjectCfg[]>,
    ]);
    const settings = await api.getSettings();
    defaultAccountId = (settings?.["default_account_id"] as string | null | undefined) ?? null;
  } catch (e) {
    console.error("[automation] account row load failed", e);
  }

  if (accounts.length === 0) {
    control.innerHTML = `<span class="acc-row-empty-hint">No accounts yet — add one in Settings &gt; Accounts.</span>`;
    return;
  }

  const proj = projects.find((p) => p.path === cwd);
  // Backend-normalized override: resolves worktree/casing cases the raw
  // find() above misses. On throw (e.g. remote transport, no mirror yet)
  // fall back to the raw match's own field.
  let resolvedAccountId: string | null | undefined;
  try {
    resolvedAccountId = await api.resolveProjectAccount(cwd);
  } catch {
    resolvedAccountId = undefined;
  }
  const currentId = (resolvedAccountId !== undefined ? resolvedAccountId : proj?.preferred_account_id) ?? "";
  const defaultAccount = accounts.find((a) => a.id === defaultAccountId) ?? null;
  const defaultLabel = defaultAccount ? `Default (${defaultAccount.label})` : "Default";
  const current = accounts.find((a) => a.id === currentId) ?? null;

  control.innerHTML = `
    ${current ? accountIconBadgeHtml(current) : `<i class="ph ph-user-circle" style="font-size:20px"></i>`}
    <select id="automationAccountSelect" class="inline-select">
      <option value="">${escapeHtml(defaultLabel)}</option>
      ${accounts.map((a) => `<option value="${escapeHtml(a.id)}"${a.id === currentId ? " selected" : ""}>${escapeHtml(a.label)}</option>`).join("")}
    </select>
  `;

  const select = document.getElementById("automationAccountSelect") as HTMLSelectElement | null;
  if (select) {
    select.onchange = () => {
      void (async () => {
        select.disabled = true;
        try {
          let id = proj?.id;
          if (!id) {
            const ensured = await api.ensureProject(cwd);
            id = ensured.id;
          }
          await api.updateProject(id, { preferred_account_id: select.value || null });
          showToast("Account updated.");
        } catch (e) {
          console.error("[automation] update account binding failed", e);
          showToast(`Could not update account: ${e}`);
        } finally {
          await renderAccountRow();
        }
      })();
    };
  }
}

/** Opt-in for the account's claude.ai connectors (Google Drive etc.) in
 * this project's chats. Takes effect on the next turn's spawn. */
async function renderConnectorsRow(): Promise<void> {
  const cwd = getProjectDetailState().cwd;
  const toggle = document.getElementById("connectorsEnabled") as HTMLInputElement | null;
  if (!cwd || !toggle) return;
  const projects = (await api.listProjects()) as unknown as ProjectCfg[];
  const proj = projects.find((p) => p.path === cwd);
  toggle.checked = !!proj?.claude_ai_connectors;
  toggle.onchange = () => {
    void (async () => {
      toggle.disabled = true;
      try {
        const id = proj?.id ?? (await api.ensureProject(cwd)).id;
        await api.updateProject(id, { claude_ai_connectors: toggle.checked });
        showToast(toggle.checked ? "Connectors on for new turns." : "Connectors off for new turns.");
      } catch (e) {
        console.error("[automation] update connectors failed", e);
        showToast(`Could not update connectors: ${e}`);
      } finally {
        toggle.disabled = false;
        await renderConnectorsRow();
      }
    })();
  };
}

const TRACKER_LABEL: Record<string, string> = { shortcut: "Shortcut", linear: "Linear" };

/** Where this project's tickets live, so chat mentions link to them. Unset
 *  means "infer from the git remote", shown as that inferred answer. */
async function renderTrackerRow(): Promise<void> {
  const cwd = getProjectDetailState().cwd;
  const control = document.getElementById("trackerControl");
  if (!cwd || !control) return;
  const projects = (await api.listProjects()) as unknown as ProjectCfg[];
  const proj = projects.find((p) => p.path === cwd);
  const own = proj?.tracker ?? null;
  let inferred: TrackerInfo | null = null;
  if (!own) inferred = await invoke<TrackerInfo | null>("get_ticket_tracker", { cwd }).catch(() => null);
  const autoLabel = inferred ? `Auto (${TRACKER_LABEL[inferred.kind]}, ${inferred.workspace})` : "Auto (none found)";
  const kind = own?.kind ?? "";
  const workspace = own?.workspace ?? inferred?.workspace ?? "";
  const opt = (v: string, label: string) => `<option value="${v}"${v === kind ? " selected" : ""}>${escapeHtml(label)}</option>`;
  control.innerHTML = `
    <select id="trackerKind" class="inline-select">
      ${opt("", autoLabel)}${opt("shortcut", "Shortcut")}${opt("linear", "Linear")}${opt("off", "None")}
    </select>
    <input id="trackerWorkspace" class="inline-input" type="text" placeholder="workspace" value="${escapeHtml(workspace)}"${kind === "shortcut" || kind === "linear" ? "" : " hidden"}>
  `;
  const select = document.getElementById("trackerKind") as HTMLSelectElement | null;
  const input = document.getElementById("trackerWorkspace") as HTMLInputElement | null;
  if (!select || !input) return;
  const save = async () => {
    const k = select.value;
    if ((k === "shortcut" || k === "linear") && !input.value.trim()) {
      input.hidden = false;
      input.focus();
      return;
    }
    select.disabled = true;
    try {
      const id = proj?.id ?? (await api.ensureProject(cwd)).id;
      const tracker = k ? { kind: k, workspace: k === "off" ? "" : input.value.trim() } : null;
      await api.updateProject(id, { tracker });
      forgetTicketTracker(cwd);
      showToast("Ticket links updated for new messages and turns.");
    } catch (e) {
      console.error("[automation] update tracker failed", e);
      showToast(`Could not update ticket tracker: ${e}`);
    } finally {
      await renderTrackerRow();
    }
  };
  select.onchange = () => void save();
  input.onchange = () => void save();
}

async function renderAutomationForm(): Promise<void> {
  const cwd = getProjectDetailState().cwd;
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

export async function renderAutomationView(
  root: HTMLElement,
): Promise<() => void> {
  const { avatar, title, cwd: headerCwd } = projectSubviewHeaderData();
  render(template(avatar, title, headerCwd), root);
  void hydrateSubviewHeader(root);

  const automate = root.querySelector<HTMLButtonElement>("#automateChannelBtn");
  if (automate) {
    automate.onclick = async () => {
      const cwd = getProjectDetailState().cwd;
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
      await renderAutomationForm();
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
      await renderAutomationForm();
      showToast("Automation removed.");
    };
  }

  await renderAutomationForm();
  await renderAccountRow();
  await renderConnectorsRow();
  await renderTrackerRow();

  return () => { /* no teardown */ };
}

function template(avatar: Avatar, title: string, projectPath?: string) {
  return html`
    <div class="view view-project-automation">
      <div class="view-header subview-header">
        ${subviewHeaderTemplate(avatar, title, () => backFromSubview(), projectPath)}
      </div>
      <div class="view-body">
        <section class="automation-section" id="accountSection" style="margin-top:12px">
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
    </div>
  `;
}
