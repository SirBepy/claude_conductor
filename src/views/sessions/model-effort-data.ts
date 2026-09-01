/** Resolves the four cached reads `openModelEffortModal` needs (settings,
 *  project list, accounts list, project's bound account) into the plain
 *  state the modal renders from - split out of model-effort-modal.ts's
 *  loadAndBuild() (todo 810). */

import type { Account, ProjectConfig } from "../../shared/api";
import { resolveCached, type CacheRead } from "./new-session-cache";
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
  remote: boolean;
  projectId: string | null;
  preferredAccountId: string | null;
  accounts: Account[];
  accountId: string | null;
  idByFamily: Map<string, string>;
}

export async function resolveModelEffortData(
  projectPath: string,
  settingsRead: CacheRead<Record<string, unknown>>,
  projectsRead: CacheRead<ProjectConfig[]>,
  accountsRead: CacheRead<Account[]>,
  projectAccountRead: CacheRead<string | null>,
): Promise<ModelEffortResolvedData> {
  const settingsRaw = await resolveCached(settingsRead, {} as Record<string, unknown>);
  const models = readModels(settingsRaw);
  const defaultFlags = readDefaultFlags(settingsRaw);
  // No presets anymore - first-ever session in a project defaults to Opus/high.
  const initial = readLastChoice(settingsRaw, projectPath) ?? { model: "opus", effort: "high" };

  // Resolve projectId for whitelist + live-taken dedup, and the project's
  // bound account (if any) for the account picker below.
  const projectsListVal: ProjectConfig[] = await resolveCached(projectsRead, [] as ProjectConfig[]);
  const proj = projectsListVal.find((p) => String(p.path) === projectPath) as
    | { id: string; preferred_account_id?: string | null }
    | undefined;
  const projectId = proj?.id ?? null;
  let preferredAccountId = proj?.preferred_account_id ?? null;
  // Backend-normalized override: resolves worktree/casing cases the raw
  // find() above misses. On throw (e.g. remote transport, no mirror yet)
  // keep the raw-match result from above as a best-effort fallback.
  try {
    preferredAccountId = projectAccountRead.cached !== undefined
      ? projectAccountRead.cached
      : await projectAccountRead.ready;
  } catch {
    // keep raw-match fallback
  }

  // Account picker (multi-account milestone 04): resolve project binding ->
  // default -> sole-account fallback -> null (ambiguous/empty registry).
  const accounts = await resolveCached(accountsRead, [] as Account[]);
  const defaultAccountId = (settingsRaw["default_account_id"] as string | null | undefined) ?? null;
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
    remote: defaultFlags.remote,
    projectId,
    preferredAccountId,
    accounts,
    accountId,
    idByFamily,
  };
}
