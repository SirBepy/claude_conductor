// The config a new chat opens on. There is no new-chat dialog: every entry
// point (sidebar +, FAB, Ctrl+N, favourites, dashboard, /clear, pickup) goes
// straight to the draft, which owns every choice from there (model/effort
// chips, account chip, header avatar). This module resolves what the draft
// starts with and remembers the choices once the first message is sent.

import type { Account, Character } from "../../shared/api";
import { api } from "../../shared/api";
import { updateSettings } from "../../shared/settings-update";
import { isRemote } from "../../shared/transport";
import { playCharacterSelectSound } from "../../shared/character-select-sound";
import { isApiCreditAccount } from "../../shared/account-chip";
import type { SessionConfig } from "../../shared/effort-presets";
import { state } from "./state";
import { characterForSession } from "./session-characters";
import { loadMachineAccounts } from "./machine-accounts";
import { resolveModelEffortData, type AccountSource } from "./model-effort-data";
import {
  settingsData,
  projectsListData,
  accountsListData,
  projectAccountData,
  whitelistCharsData,
  resolveCached,
} from "./new-session-cache";

/** Character ids held by live chats, so a fresh draft doesn't share a face. */
export function liveTakenCharacterIds(): Set<string> {
  return new Set(
    state.sessions
      .filter((s) => !s.ended_at && !(s as { end_reason?: unknown }).end_reason)
      .map((s) => characterForSession(s))
      .filter((id): id is string => id !== null),
  );
}

/** Random pick preferring a character no live chat holds; falls back to the
 *  whole pool rather than leaving the draft faceless. */
export function pickRandomCharacter(pool: readonly Character[], taken: ReadonlySet<string>): Character | null {
  if (pool.length === 0) return null;
  const free = pool.filter((c) => !taken.has(c.id));
  const from = free.length > 0 ? free : pool;
  return from[Math.floor(Math.random() * from.length)] ?? null;
}

/** Model/effort = the project's last choice (Opus/high the first time).
 *  Account = the project's binding, else the default account, else none: with
 *  several accounts and no default the draft opens with no account and the
 *  first send asks for one (pending-pane-composer.ts), never a guess. A chat
 *  aimed at a paired machine reads that machine's accounts, since account ids
 *  are per machine. */
export async function resolveNewChatConfig(
  projectPath: string,
  machineId: string | null = null,
): Promise<SessionConfig> {
  let source: AccountSource;
  if (machineId) {
    const loaded = await loadMachineAccounts(machineId, projectPath);
    source = {
      kind: "machine",
      list: loaded.list ?? { accounts: [], default_account_id: null, project_account_id: null },
    };
  } else {
    source = {
      kind: "local",
      projectsRead: projectsListData(),
      accountsRead: accountsListData(),
      projectAccountRead: projectAccountData(projectPath),
    };
  }
  const data = await resolveModelEffortData(projectPath, settingsData(), source);

  // A paired machine's project ids mean nothing here, so its draft keeps the
  // muted placeholder and the host rolls a character at spawn.
  let characterId: string | null = null;
  if (!machineId && data.projectId) {
    const pool = await resolveCached(whitelistCharsData(data.projectId), [] as Character[]).catch(() => []);
    const pick = pickRandomCharacter(pool, liveTakenCharacterIds());
    if (pick) {
      characterId = pick.id;
      playCharacterSelectSound(pick.id);
    }
  }

  return {
    model: data.model,
    effort: data.effort,
    autoAccept: data.autoAccept,
    accountId: data.accountId,
    characterId,
    machineId,
  };
}

/** True when the first send must wait for an account pick. No account with
 *  none registered is fine (the daemon resolves its own default); no account
 *  while accounts exist means none was bound or default, which is the user's
 *  call to make. A paired machine with no account resolved is never a guess. */
export async function accountPickNeeded(config: SessionConfig): Promise<boolean> {
  if (config.accountId) return false;
  if (config.machineId) return true;
  const accounts = await resolveCached(accountsListData(), []);
  return accounts.length > 0;
}

/** True when this machine has no account registered at all, so a first send
 *  or schedule could only fail daemon-side with NoAccounts. A list that fails
 *  to load is NOT "none": blocking the send on a transient read error would
 *  strand a user who does have accounts. A paired machine's chat is never
 *  "none" here, its accounts live on the peer and `accountPickNeeded` already
 *  gates it. */
export async function noAccountsRegistered(config: SessionConfig): Promise<boolean> {
  if (config.accountId || config.machineId) return false;
  const accounts = await resolveCached(accountsListData(), null as Account[] | null);
  return accounts !== null && accounts.length === 0;
}

/** Remember this chat's model/effort as the project's next default, and bind
 *  its account to the project when it differs from the current binding, so
 *  the next draft here opens on it. Best-effort: never blocks the send. The
 *  phone can't write settings or projects, but a paired
 *  machine's binding is a forwarded write the phone may make. */
export async function persistNewChatChoice(projectPath: string, config: SessionConfig): Promise<void> {
  if (!isRemote()) {
    try {
      await updateSettings((cur) => {
        const lc = (cur["projectLastChoice"] && typeof cur["projectLastChoice"] === "object")
          ? { ...(cur["projectLastChoice"] as Record<string, unknown>) }
          : {};
        lc[projectPath] = { model: config.model, effort: config.effort };
        return { ...cur, projectLastChoice: lc };
      });
    } catch (e) {
      console.error("[new-chat-config] saving the last model/effort failed", e);
    }
  }

  const accountId = config.accountId ?? null;
  if (accountId === null) return;
  if (config.machineId) {
    try {
      await api.setMachineProjectAccount(config.machineId, projectPath, accountId);
    } catch (e) {
      console.error("[new-chat-config] saving the binding on the paired machine failed", e);
    }
    return;
  }
  if (isRemote()) return;
  try {
    // An API-credit account is never a project binding (CLAUDE.md): picking
    // it bills this one chat only.
    const accounts = await resolveCached(accountsListData(), []);
    if (isApiCreditAccount(accounts.find((a) => a.id === accountId))) return;
    const bound = await resolveCached(projectAccountData(projectPath), null as string | null).catch(() => null);
    if (bound === accountId) return;
    const projects = await resolveCached(projectsListData(), []);
    const id = projects.find((p) => String(p.path) === projectPath)?.id ?? (await api.ensureProject(projectPath)).id;
    await api.updateProject(id, { preferred_account_id: accountId });
  } catch (e) {
    console.error("[new-chat-config] binding the account to the project failed", e);
  }
}
