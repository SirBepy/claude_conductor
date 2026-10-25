/** Resolves the cached reads `openModelEffortModal` needs (settings, project
 *  list, accounts list, project's bound account) into the plain state the
 *  modal renders from - split out of model-effort-modal.ts's loadAndBuild(). */

import type { Account, MachineAccountList, ProjectConfig } from "../../shared/api";
import type { AccountLite } from "../../shared/account-chip";
import type { SessionConfig } from "../../shared/effort-presets";
import {
  resolveCached,
  settingsData,
  projectsListData,
  accountsListData,
  projectAccountData,
  type CacheRead,
} from "./new-session-cache";
import { resolveInitialAccountId } from "./account-picker-logic";
import {
  readLastChoice,
  readModels,
  readDefaultFlags,
  latestIdForFamily,
} from "../../shared/effort-presets";

export interface ModelEffortResolvedData {
  models: string[];
  model: string;
  effort: string;
  autoAccept: boolean;
  projectId: string | null;
  preferredAccountId: string | null;
  accounts: AccountLite[];
  accountId: string | null;
  idByFamily: Map<string, string>;
}

/** Where the account step's data comes from: this machine's caches, or a
 *  paired machine's own answer (a chat aimed at that machine). */
export type AccountSource =
  | {
      kind: "local";
      projectsRead: CacheRead<ProjectConfig[]>;
      accountsRead: CacheRead<Account[]>;
      projectAccountRead: CacheRead<string | null>;
    }
  | { kind: "machine"; list: MachineAccountList };

/** The choices the modal would open on, for a launch that skips it (a
 *  dashboard card's button). Null when the modal has to ask for an account
 *  (none registered, or several and no default), so the caller opens it. */
export async function defaultSessionConfig(projectPath: string): Promise<SessionConfig | null> {
  const data = await resolveModelEffortData(projectPath, settingsData(), {
    kind: "local",
    projectsRead: projectsListData(),
    accountsRead: accountsListData(),
    projectAccountRead: projectAccountData(projectPath),
  });
  if (data.accounts.length === 0 || data.accountId === null) return null;
  return { model: data.model, effort: data.effort, autoAccept: data.autoAccept, accountId: data.accountId };
}

export async function resolveModelEffortData(
  projectPath: string,
  settingsRead: CacheRead<Record<string, unknown>>,
  source: AccountSource,
): Promise<ModelEffortResolvedData> {
  const settingsRaw = await resolveCached(settingsRead, {} as Record<string, unknown>);
  const models = readModels(settingsRaw);
  const defaultFlags = readDefaultFlags(settingsRaw);
  // No presets anymore - first-ever session in a project defaults to Opus/high.
  const initial = readLastChoice(settingsRaw, projectPath) ?? { model: "opus", effort: "high" };

  let projectId: string | null = null;
  let preferredAccountId: string | null;
  let accounts: AccountLite[];
  let defaultAccountId: string | null;

  if (source.kind === "machine") {
    // The path names a folder on ANOTHER machine, so neither this machine's
    // project list nor its binding apply; the host already resolved its own.
    preferredAccountId = source.list.project_account_id;
    accounts = source.list.accounts;
    defaultAccountId = source.list.default_account_id;
  } else {
    // Resolve projectId for whitelist + live-taken dedup, and the project's
    // bound account (if any) for the account picker below.
    const projectsListVal: ProjectConfig[] = await resolveCached(source.projectsRead, [] as ProjectConfig[]);
    const proj = projectsListVal.find((p) => String(p.path) === projectPath) as
      | { id: string; preferred_account_id?: string | null }
      | undefined;
    projectId = proj?.id ?? null;
    preferredAccountId = proj?.preferred_account_id ?? null;
    // Backend-normalized override: resolves worktree/casing cases the raw
    // find() above misses. On throw (e.g. remote transport, no mirror yet)
    // keep the raw-match result from above as a best-effort fallback.
    try {
      preferredAccountId = source.projectAccountRead.cached !== undefined
        ? source.projectAccountRead.cached
        : await source.projectAccountRead.ready;
    } catch {
      // keep raw-match fallback
    }
    accounts = await resolveCached(source.accountsRead, [] as Account[]);
    defaultAccountId = (settingsRaw["default_account_id"] as string | null | undefined) ?? null;
  }

  // Account picker (multi-account milestone 04): resolve project binding ->
  // default -> sole-account fallback -> null (ambiguous/empty registry).
  const accountId = resolveInitialAccountId(preferredAccountId, defaultAccountId, accounts);

  const idByFamily = new Map<string, string>();
  for (const fam of models) {
    const id = latestIdForFamily(fam);
    if (id) idByFamily.set(fam, id);
  }

  return {
    models,
    model: initial.model,
    effort: initial.effort,
    autoAccept: defaultFlags.autoAccept,
    projectId,
    preferredAccountId,
    accounts,
    accountId,
    idByFamily,
  };
}
