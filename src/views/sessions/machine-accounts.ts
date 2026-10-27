// A new chat's account resolution for a chat aimed at a paired machine: that
// machine's accounts, its default and its binding for the project. Account ids
// are per machine, so none of this can come from the local caches in
// new-session-cache.ts, and nothing here is cached: a stale list would offer
// an account the host no longer has.

import { api } from "../../shared/api";
import type { MachineAccountList } from "../../shared/api";

export interface MachineAccountsLoad {
  /** The peer's name for the picker's messages. */
  label: string;
  /** Null exactly when `error` is set. */
  list: MachineAccountList | null;
  error: string | null;
}

/** Never rejects: an unreachable machine is a state the modal renders (and
 * gates Start on), not an exception to unwind through the open flow. */
export async function loadMachineAccounts(machineId: string, cwd: string): Promise<MachineAccountsLoad> {
  const [accounts, machines] = await Promise.allSettled([
    api.listMachineAccounts(machineId, cwd),
    api.listMachines(),
  ]);
  const label =
    (machines.status === "fulfilled"
      ? machines.value.peers.find((p) => p.machine_id === machineId)?.label
      : undefined) ?? "the other machine";
  if (accounts.status === "fulfilled") return { label, list: accounts.value, error: null };
  console.error("[new-chat] list_machine_accounts failed", accounts.reason);
  const reason = accounts.reason;
  const text = reason instanceof Error ? reason.message : String(reason);
  return { label, list: null, error: text || "request failed" };
}
