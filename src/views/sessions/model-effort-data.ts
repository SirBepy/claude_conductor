/** Resolves the cached reads a new chat's config needs (settings, project
 *  list, accounts list, project's bound account) into plain state - read by
 *  new-chat-config.ts's resolveNewChatConfig. */

import type { Account, MachineAccountList, ProjectConfig } from "../../shared/api";
import { isApiCreditAccount, type AccountLite } from "../../shared/account-chip";
import { resolveCached, type CacheRead } from "./new-session-cache";
import { resolveInitialAccountId } from "./account-picker-logic";
import {
  resolveDefaultChoice,
  readModels,
  readDefaultFlags,
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

export async function resolveModelEffortData(
  projectPath: string,
  settingsRead: CacheRead<Record<string, unknown>>,
  source: AccountSource,
): Promise<ModelEffortResolvedData> {
  const settingsRaw = await resolveCached(settingsRead, {} as Record<string, unknown>);
  const models = readModels(settingsRaw);
  const defaultFlags = readDefaultFlags(settingsRaw);
  let projectId: string | null = null;
  // A paired machine's project defaults live on that machine; its draft opens on this one's global default.
  let projectDefault: { default_model?: string | null; default_effort?: string | null } | undefined;
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
      | { id: string; preferred_account_id?: string | null; default_model?: string | null; default_effort?: string | null }
      | undefined;
    projectId = proj?.id ?? null;
    preferredAccountId = proj?.preferred_account_id ?? null;
    projectDefault = proj;
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
    // A stored binding to an API-credit account is ignored, not honoured: the
    // raw match above (and a failed backend read) can still carry one.
    if (accounts.some((a) => a.id === preferredAccountId && isApiCreditAccount(a))) {
      preferredAccountId = null;
    }
    defaultAccountId = (settingsRaw["default_account_id"] as string | null | undefined) ?? null;
  }

  // Account picker (multi-account milestone 04): resolve project binding ->
  // default -> sole-account fallback -> null (ambiguous/empty registry).
  const accountId = resolveInitialAccountId(preferredAccountId, defaultAccountId, accounts);

  const initial = resolveDefaultChoice(settingsRaw, projectDefault);

  return {
    models,
    model: initial.model,
    effort: initial.effort,
    autoAccept: defaultFlags.autoAccept,
    projectId,
    preferredAccountId,
    accounts,
    accountId,
  };
}
