// Remote-machine project fetching/state for the project picker's machine
// switch (multi-machine federation, H4). Split out of project-picker.ts
// (3a45b917 added this inline) - project-picker.ts owns the modal, this owns
// the list_machine_projects fetch + its loading/error state.

import type { ProjectGroup } from "../../../types/ipc.generated";
import { api, type ProjectConfig } from "../../../shared/api";

/** Maps a peer machine's bare `ProjectConfig` (no avatar/todo/worktree data -
 * that's all local-only enrichment) into the row shape the picker already
 * renders. `avatar` deliberately isn't {kind:"none"}: that renders a
 * hydratable `.proj-face` placeholder, and hydrateProjectTechIcons would then
 * probe THIS machine's filesystem for a path that only exists on the peer. */
export function projectConfigToGroup(pc: ProjectConfig): ProjectGroup {
  const path = String(pc.path);
  const rawName = (pc as { name?: unknown }).name;
  const name = typeof rawName === "string" && rawName
    ? rawName
    : path.replace(/\\/g, "/").split("/").filter(Boolean).pop() || path;
  return {
    id: pc.id, path, name,
    parent_segment: null,
    avatar: { kind: "emoji", value: "📁" },
    automation_enabled: false,
    tokens_7d: 0n,
    live: 0,
    any_remote: false,
    any_automated: false,
    last_active_at: null,
    path_exists: true, // can't stat a peer's filesystem from here
    worktrees: [],
    last_worktree_path: null,
    last_start_folder_rel: null,
  };
}

export interface MachineProjectsState {
  projects: ProjectGroup[] | undefined;
  loading: boolean;
  error: string | null;
}

export function createMachineProjectsState(): MachineProjectsState {
  return { projects: undefined, loading: false, error: null };
}

/** Fetches `list_machine_projects` for `machineId` into `state`, then calls
 * `onChange`. `isStale` is checked after the fetch settles (the modal closed,
 * or the dev picked a different machine before this one returned) - a stale
 * response is dropped instead of painting over a newer pick. */
export function fetchMachineProjects(
  state: MachineProjectsState,
  machineId: string,
  isStale: () => boolean,
  onChange: () => void,
): void {
  state.projects = undefined;
  state.loading = true;
  state.error = null;
  void api.listMachineProjects(machineId).then((list) => {
    if (isStale()) return;
    state.projects = list.map(projectConfigToGroup);
    state.loading = false;
    onChange();
  }).catch((err: unknown) => {
    if (isStale()) return;
    console.error("[sessions] list_machine_projects failed", err);
    state.error = err instanceof Error ? err.message : "Failed to load projects";
    state.loading = false;
    onChange();
  });
}
