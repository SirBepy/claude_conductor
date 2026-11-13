import { escapeHtml } from "../../../../shared/escape-html";
import { showToast } from "../../../../shared/toast";
import { api } from "../../../../shared/api";
import type { Account } from "../../../../shared/api";
import { accountIconBadgeHtml, isApiCreditAccount } from "../../../../shared/account-chip";
import { invoke } from "../../../../shared/ipc";
import { updateSettings } from "../../../../shared/settings-update";
import { kToTokens, readAutoCompact, tokensToK, withAutoCompact } from "../../../../shared/auto-compact";
import type { AutoCompact } from "../../../../shared/auto-compact";
import { forgetTicketTracker, normalizeTrelloBoard } from "../../../../shared/chat/ticket-refs";
import type { TrackerInfo } from "../../../../types/ipc.generated";
import type { ProjectCfg } from "./project-cfg";
import "../../../../shared/account-chip.css";

/** Which account new chats in this project spawn under (multi-account
 * milestone 04): the project's own binding if set, else the global default,
 * shown here only as the "Default (X)" option label - not resolved to an id.
 */
export async function renderAccountRow(cwd: string): Promise<void> {
  const control = document.getElementById("projectAccountControl");
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
    console.error("[project-settings] account row load failed", e);
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
    <select id="projectAccountSelect" class="inline-select">
      <option value="">${escapeHtml(defaultLabel)}</option>
      ${accounts.map((a) => `<option value="${escapeHtml(a.id)}"${a.id === currentId ? " selected" : ""}>${escapeHtml(a.label)}</option>`).join("")}
    </select>
  `;

  const select = document.getElementById("projectAccountSelect") as HTMLSelectElement | null;
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
          console.error("[project-settings] update account binding failed", e);
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
        console.error(`[project-settings] update ${row.what} failed`, e);
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

/** Compaction of this project's main chats: a switch and a size in K tokens.
 *  Stored in the settings' `autoCompact.projects[<project id>]`, which overrides
 *  Settings > Chat defaults field by field, so each field shows the value in
 *  force (this project's, else the global one). A project with no config yet is
 *  created on first change via `ensureProject`. */
export async function renderCompactionRow(cwd: string, knownId?: string): Promise<void> {
  const toggle = document.getElementById("compactOn") as HTMLInputElement | null;
  const sizeInput = document.getElementById("compactK") as HTMLInputElement | null;
  if (!cwd || !toggle || !sizeInput) return;
  const [projects, settings] = await Promise.all([
    api.listProjects() as unknown as Promise<ProjectCfg[]>,
    api.getSettings().then((s) => (s ?? {}) as Record<string, unknown>),
  ]);
  const proj = projects.find((p) => p.path === cwd);
  // A path the list does not match literally (case, slashes, a worktree) is
  // registered under another id by ensureProject; the id it gave last time is
  // passed back so the redraw reads the entry just written, not the global one.
  const projectId = proj?.id ?? knownId ?? null;
  const current = readAutoCompact(settings, projectId);
  toggle.checked = current.on;
  sizeInput.value = String(tokensToK(current.tokens));

  const save = (patch: Partial<AutoCompact>, toast: string): void => {
    void (async () => {
      toggle.disabled = sizeInput.disabled = true;
      let id = projectId;
      try {
        const target = id ?? (await api.ensureProject(cwd)).id;
        id = target;
        await updateSettings((fresh) => withAutoCompact(fresh, target, patch));
        showToast(toast);
      } catch (e) {
        console.error("[project-settings] update compaction failed", e);
        showToast(`Could not update compaction: ${e}`);
      } finally {
        toggle.disabled = sizeInput.disabled = false;
        await renderCompactionRow(cwd, id ?? undefined);
      }
    })();
  };
  toggle.onchange = () => save({ on: toggle.checked }, toggle.checked ? "Main chats here are compacted automatically." : "Main chats here are no longer compacted automatically.");
  sizeInput.onchange = () => {
    const tokens = kToTokens(sizeInput.value);
    if (tokens === null) { sizeInput.value = String(tokensToK(current.tokens)); return; }
    save({ tokens }, "Compaction size updated.");
  };
}

const TRACKER_LABEL: Record<string, string> = { shortcut: "Shortcut", linear: "Linear", trello: "Trello" };

// Trello's field is a board (card numbers only mean something per board), the
// others' is a workspace slug.
const workspacePlaceholder = (kind: string) => (kind === "trello" ? "board id (trello.com/b/<id>)" : "workspace");
const needsWorkspace = (kind: string) => kind === "shortcut" || kind === "linear" || kind === "trello";

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
  // Leads with a badge like the Account row's, so the two stacked selects read as siblings.
  control.innerHTML = `
    <span class="account-icon-badge"><i class="ph ph-ticket"></i></span>
    <span class="tracker-fields">
      <select id="trackerKind" class="inline-select">
        ${opt("", autoLabel)}${opt("shortcut", "Shortcut")}${opt("linear", "Linear")}${opt("trello", "Trello")}${opt("off", "None")}
      </select>
      <input id="trackerWorkspace" class="inline-input" type="text" placeholder="${workspacePlaceholder(kind)}" value="${escapeHtml(workspace)}"${needsWorkspace(kind) ? "" : " hidden"}>
    </span>
  `;
  const select = document.getElementById("trackerKind") as HTMLSelectElement | null;
  const input = document.getElementById("trackerWorkspace") as HTMLInputElement | null;
  if (!select || !input) return;
  const save = async () => {
    const k = select.value;
    if (needsWorkspace(k) && !input.value.trim()) {
      input.placeholder = workspacePlaceholder(k);
      input.hidden = false;
      input.focus();
      return;
    }
    // A pasted board URL is reduced to its id, and anything else unusable is
    // refused here: saved as-is, every tr-N lookup would fail with no visible cause.
    const board = k === "trello" ? normalizeTrelloBoard(input.value) : null;
    if (k === "trello" && !board) {
      showToast("Trello board id: use the id from trello.com/b/<id>.");
      input.focus();
      return;
    }
    select.disabled = true;
    try {
      const id = proj?.id ?? (await api.ensureProject(cwd)).id;
      const workspace = k === "off" ? "" : (board ?? input.value.trim());
      const tracker = k ? { kind: k, workspace } : null;
      await api.updateProject(id, { tracker });
      forgetTicketTracker(cwd);
      showToast("Ticket links updated for new messages and turns.");
    } catch (e) {
      console.error("[project-settings] update tracker failed", e);
      showToast(`Could not update ticket tracker: ${e}`);
    } finally {
      await renderTrackerRow(cwd);
    }
  };
  select.onchange = () => {
    // A Shortcut/Linear slug is not a Trello board id, so crossing that line drops it.
    if ((select.value === "trello") !== (kind === "trello")) input.value = "";
    void save();
  };
  input.onchange = () => void save();
}
