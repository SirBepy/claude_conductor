// Remote-machine project fetching/state for the project picker's machine
// switch (multi-machine federation, H4). Split out of project-picker.ts
// (3a45b917 added this inline) - project-picker.ts owns the modal, this owns
// the list_machine_projects fetch + its loading/error state.

import type { ProjectGroup } from "../../../types/ipc.generated";
import { api, type MachineProjectStat } from "../../../shared/api";

/** Turns one project group the peer built (icons, worktrees, last activity,
 * all measured against ITS disk) into a row this machine's picker renders.
 *
 * Only an emoji avatar survives: it is plain text and means the same
 * everywhere. An image avatar is a file path on the peer's disk and a
 * character avatar names a roster this machine may not share, so both - and
 * "no avatar" - become {kind:"none"}, which renders the `.proj-face`
 * placeholder that hydrateProjectTechIcons fills by asking the peer
 * (through `data-proj-face-machine`) for the project's own icon or tech logo. */
export function remoteGroupToRow(g: ProjectGroup): ProjectGroup {
  return { ...g, avatar: g.avatar?.kind === "emoji" ? g.avatar : { kind: "none" } };
}

export interface MachineProjectsState {
  /** The machine `projects`/`stats` came from, or null before any fetch.
   * Stats are keyed by the peer's own paths, which can coincide with a path
   * on this machine, so a reader must check this before trusting a lookup. */
  machineId: string | null;
  projects: ProjectGroup[] | undefined;
  /** Todo count and last activity per project path, from the peer. */
  stats: Record<string, MachineProjectStat>;
  loading: boolean;
  error: string | null;
}

export function createMachineProjectsState(): MachineProjectsState {
  return { machineId: null, projects: undefined, stats: {}, loading: false, error: null };
}

/** The peer-supplied stat for a row, or undefined when `machineId` is not the
 * machine the state was last filled from (a switch whose fetch hasn't landed). */
export function machineProjectStat(
  state: MachineProjectsState,
  machineId: string,
  path: string,
): MachineProjectStat | undefined {
  return state.machineId === machineId ? state.stats[path] : undefined;
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
  state.machineId = machineId;
  state.projects = undefined;
  state.stats = {};
  state.loading = true;
  state.error = null;
  void api.listMachineProjects(machineId).then((res) => {
    if (isStale()) return;
    state.projects = (res.groups ?? []).map(remoteGroupToRow);
    state.stats = res.stats ?? {};
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
