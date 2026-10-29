import { html, render } from "lit-html";
import { escapeHtml } from "../../../../shared/escape-html";
import { showToast } from "../../../../shared/toast";
import { api } from "../../../../shared/api";
import type { Account } from "../../../../shared/api";
import { accountIconBadgeHtml, isApiCreditAccount } from "../../../../shared/account-chip";
import { invoke } from "../../../../shared/ipc";
import { forgetTicketTracker } from "../../../../shared/chat/ticket-refs";
import {
  isEffort, modelDisplayLabel, modelFamilyFromId, readGlobalDefault, readModels, EFFORTS,
} from "../../../../shared/effort-presets";
import { projectsListData } from "../../new-session-cache";
import type { TicketTracker, TrackerInfo } from "../../../../types/ipc.generated";
import "../../../../shared/account-chip.css";
import "./automation.css";

/** The project the popup is showing; every row reads it. One popup is open at a time. */
let currentCwd = "";

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
  keep_running_in_gaming_mode?: boolean;
  default_model?: string | null;
  default_effort?: string | null;
}

/** What a new chat in this project opens on. An unset half follows Settings >
 *  Chat defaults, which the first option names, so the row always shows what a
 *  new chat will actually start with. */
async function renderChatDefaultsRow(): Promise<void> {
  const cwd = currentCwd;
  const modelControl = document.getElementById("chatDefaultModelControl");
  const effortControl = document.getElementById("chatDefaultEffortControl");
  if (!cwd || !modelControl || !effortControl) return;

  let projects: ProjectCfg[] = [];
  let settings: Record<string, unknown> = {};
  try {
    [projects, settings] = await Promise.all([
      api.listProjects() as unknown as Promise<ProjectCfg[]>,
      api.getSettings().then((s) => s ?? {}),
    ]);
  } catch (e) {
    console.error("[automation] chat defaults load failed", e);
  }
  const proj = projects.find((p) => p.path === cwd);
  const global = readGlobalDefault(settings);
  const ownModel = proj?.default_model ? modelFamilyFromId(proj.default_model) : "";
  const ownEffort = isEffort(proj?.default_effort) ? proj.default_effort : "";
  const models = readModels(settings);
  if (ownModel && !models.includes(ownModel)) models.push(ownModel);

  const options = (own: string, defaultLabel: string, values: readonly string[], label: (v: string) => string): string =>
    `<option value=""${own ? "" : " selected"}>${escapeHtml(defaultLabel)}</option>` +
    values.map((v) => `<option value="${escapeHtml(v)}"${v === own ? " selected" : ""}>${escapeHtml(label(v))}</option>`).join("");
  modelControl.innerHTML = `<select id="chatDefaultModel" class="inline-select">${options(ownModel, `Default (${modelDisplayLabel(global.model)})`, models, modelDisplayLabel)}</select>`;
  effortControl.innerHTML = `<select id="chatDefaultEffort" class="inline-select">${options(ownEffort, `Default (${global.effort})`, EFFORTS, (v) => v)}</select>`;

  const wire = (id: string, field: "default_model" | "default_effort"): void => {
    const select = document.getElementById(id) as HTMLSelectElement | null;
    if (!select) return;
    select.onchange = () => {
      void (async () => {
        select.disabled = true;
        try {
          const projectId = proj?.id ?? (await api.ensureProject(cwd)).id;
          await api.updateProject(projectId, { [field]: select.value || null });
          // The new-chat draft reads this list from a stale-while-revalidate cache.
          await projectsListData().ready.catch(() => {});
          showToast("New chats in this project open on the new default.");
        } catch (e) {
          console.error("[automation] update chat default failed", e);
          showToast(`Could not update the default: ${e}`);
        } finally {
          await renderChatDefaultsRow();
        }
      })();
    };
  };
  wire("chatDefaultModel", "default_model");
  wire("chatDefaultEffort", "default_effort");
}

/** Which account new chats in this project spawn under (multi-account
 * milestone 04): the project's own binding if set, else the global default,
 * shown here only as the "Default (X)" option label - not resolved to an id.
 * Independent of whether the project has automation configured, so it lives
 * outside the automationEmpty/automationForm toggle below. */
async function renderAccountRow(): Promise<void> {
  const cwd = currentCwd;
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
    // An API-credit account is never a project binding (update_project refuses to save one).
    accounts = accounts.filter((a) => !isApiCreditAccount(a));
    const settings = await api.getSettings();
    defaultAccountId = (settings?.["default_account_id"] as string | null | undefined) ?? null;
  } catch (e) {
    console.error("[automation] account row load failed", e);
  }

  if (accounts.length === 0) {
    control.innerHTML = `<span class="acc-row-empty-hint">No accounts yet: add one in Settings &gt; Accounts.</span>`;
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

interface ProjectBooleanToggleRow {
  toggleId: string;
  field: "claude_ai_connectors" | "keep_running_in_gaming_mode";
  onToast: string;
  offToast: string;
  /** Names the setting in the failure log and toast. */
  what: string;
}

/** A checkbox bound to one boolean on this project's config. A project with
 *  no config yet is created on first change via `ensureProject`. */
async function renderProjectBooleanToggleRow(row: ProjectBooleanToggleRow): Promise<void> {
  const cwd = currentCwd;
  const toggle = document.getElementById(row.toggleId) as HTMLInputElement | null;
  if (!cwd || !toggle) return;
  const projects = (await api.listProjects()) as unknown as ProjectCfg[];
  const proj = projects.find((p) => p.path === cwd);
  toggle.checked = !!proj?.[row.field];
  toggle.onchange = () => {
    void (async () => {
      toggle.disabled = true;
      try {
        const id = proj?.id ?? (await api.ensureProject(cwd)).id;
        await api.updateProject(id, { [row.field]: toggle.checked });
        showToast(toggle.checked ? row.onToast : row.offToast);
      } catch (e) {
        console.error(`[automation] update ${row.what} failed`, e);
        showToast(`Could not update ${row.what}: ${e}`);
      } finally {
        toggle.disabled = false;
        await renderProjectBooleanToggleRow(row);
      }
    })();
  };
}

/** Opt-in for the account's claude.ai connectors (Google Drive etc.) in
 * this project's chats. Takes effect on the next turn's spawn. */
function renderConnectorsRow(): Promise<void> {
  return renderProjectBooleanToggleRow({
    toggleId: "connectorsEnabled",
    field: "claude_ai_connectors",
    onToast: "Connectors on for new turns.",
    offToast: "Connectors off for new turns.",
    what: "connectors",
  });
}

/** Gaming mode's per-project allowlist: a chat here is never parked, and a
 *  supervised dev-server entry rooted here is never stopped, while gaming
 *  mode is on. Exported so it can be unit-tested directly without standing
 *  up the popup's other rows. */
export function renderGamingModeRow(cwd: string): Promise<void> {
  currentCwd = cwd;
  return renderProjectBooleanToggleRow({
    toggleId: "gamingModeKeepRunning",
    field: "keep_running_in_gaming_mode",
    onToast: "Exempt from gaming mode.",
    offToast: "Parked by gaming mode like any other project.",
    what: "gaming mode setting",
  });
}

const TRACKER_LABEL: Record<string, string> = { shortcut: "Shortcut", linear: "Linear" };

/** Where this project's tickets live, so chat mentions link to them. Unset
 *  means "infer from the git remote", shown as that inferred answer. */
async function renderTrackerRow(): Promise<void> {
  const cwd = currentCwd;
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
  const cwd = currentCwd;
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
  currentCwd = cwd;
  render(template(), root);

  const automate = root.querySelector<HTMLButtonElement>("#automateChannelBtn");
  if (automate) {
    automate.onclick = async () => {
      const cwd = currentCwd;
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
  await renderChatDefaultsRow();
  await renderAccountRow();
  await renderConnectorsRow();
  await renderGamingModeRow(cwd);
  await renderTrackerRow();
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
