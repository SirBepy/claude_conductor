import { escapeHtml } from "../../../../shared/escape-html";
import { showToast } from "../../../../shared/toast";
import { api } from "../../../../shared/api";
import type { Account } from "../../../../shared/api";
import { accountIconBadgeHtml, isApiCreditAccount } from "../../../../shared/account-chip";
import { invoke } from "../../../../shared/ipc";
import { forgetTicketTracker } from "../../../../shared/chat/ticket-refs";
import type { TrackerInfo } from "../../../../types/ipc.generated";
import type { ProjectCfg } from "./project-cfg";
import "../../../../shared/account-chip.css";

/** Which account new chats in this project spawn under (multi-account
 * milestone 04): the project's own binding if set, else the global default,
 * shown here only as the "Default (X)" option label - not resolved to an id.
 * Independent of whether the project has automation configured, so it lives
 * outside the automationEmpty/automationForm toggle. */
export async function renderAccountRow(cwd: string): Promise<void> {
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
          await renderAccountRow(cwd);
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
async function renderProjectBooleanToggleRow(cwd: string, row: ProjectBooleanToggleRow): Promise<void> {
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
        await renderProjectBooleanToggleRow(cwd, row);
      }
    })();
  };
}

/** Opt-in for the account's claude.ai connectors (Google Drive etc.) in
 * this project's chats. Takes effect on the next turn's spawn. */
export function renderConnectorsRow(cwd: string): Promise<void> {
  return renderProjectBooleanToggleRow(cwd, {
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
  return renderProjectBooleanToggleRow(cwd, {
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
export async function renderTrackerRow(cwd: string): Promise<void> {
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
      await renderTrackerRow(cwd);
    }
  };
  select.onchange = () => void save();
  input.onchange = () => void save();
}
