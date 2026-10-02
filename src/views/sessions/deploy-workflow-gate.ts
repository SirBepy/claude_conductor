// Cheapest honest proxy for "the Deploy menu item (chat-menu-items.ts) won't
// just hand `/deploy` to a repo that will immediately refuse it": checks the
// session's own working tree for `.github/workflows/deploy.yml`, reusing the
// same `check_paths_exist` IPC boot.ts already uses for dead-project
// reconciliation (todo 910) - no new Tauri command needed.
//
// This is a LOCAL proxy, not the real preflight: `/deploy`'s own step 1 checks
// the DEFAULT branch on GitHub, not the local working tree. A deploy.yml that
// exists only on a feature branch makes this return true (button shows) even
// though `/deploy` will still safely refuse at its own preflight - accepted
// per todo 910's Approach note.
//
// `check_paths_exist` has no phone route, so on the phone the cache stays
// empty and the item stays enabled; `/deploy`'s own preflight still refuses
// a repo without the workflow.
//
// Cache is read synchronously so a menu open is never blocked on a `stat`
// that `check_paths_exist`'s own doc comment says can stall on a disconnected
// network drive; the refresh below is always fire-and-forget, warming the
// cache for the NEXT open rather than gating this one.

import { api } from "../../shared/api";
import { isRemote } from "../../shared/transport";

const cache = new Map<string, boolean>();

function deployWorkflowPath(cwd: string): string {
  return `${cwd.replace(/[\\/]+$/, "")}/.github/workflows/deploy.yml`;
}

/** Undefined means "not checked yet" - callers treat that as enabled (see
 *  ChatMenuCtx.hasDeployWorkflow), matching the always-enabled behavior this
 *  gate shipped without until todo 910's gating pass. */
export function cachedHasDeployWorkflow(cwd: string | null): boolean | undefined {
  return cwd ? cache.get(cwd) : undefined;
}

/** Fire-and-forget: never awaited by a menu-open path. */
export async function refreshDeployWorkflowCache(cwd: string | null): Promise<void> {
  if (!cwd || isRemote()) return;
  const path = deployWorkflowPath(cwd);
  try {
    const existsMap = await api.checkPathsExist([path]);
    cache.set(cwd, !!existsMap[path]);
  } catch (e) {
    console.error("[deploy-workflow-gate] check_paths_exist failed", e);
  }
}
