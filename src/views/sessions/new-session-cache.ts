/** Stale-while-revalidate cache for the new-session popup chain's data. Every
 *  read returns what's cached instantly and kicks a deduped background
 *  refetch that patches in place - self-healing after any external change,
 *  no invalidation event to wire up. warmNewSessionCache() primes it at boot. */

import { api } from "../../shared/api";
import type { Account, Character, ProjectConfig } from "../../shared/api";
import { invoke } from "../../shared/ipc";
import type { ProjectGroup } from "../../types/ipc.generated";

export interface ProjectStat {
  mtime: number;
  todoCount: number;
}

interface Entry<T> {
  value: T | undefined;
  inflight: Promise<T> | null;
}

export interface CacheRead<T> {
  cached: T | undefined;
  ready: Promise<T>;
}

function makeEntry<T>(): Entry<T> {
  return { value: undefined, inflight: null };
}

/** Dedupes concurrent revalidation for one entry; always fires a fresh fetch
 *  if none is already in flight, even when a cached value already exists. */
function swr<T>(entry: Entry<T>, fetcher: () => Promise<T>): CacheRead<T> {
  if (!entry.inflight) {
    entry.inflight = fetcher()
      .then((v) => { entry.value = v; entry.inflight = null; return v; })
      .catch((e) => { entry.inflight = null; throw e; });
  }
  return { cached: entry.value, ready: entry.inflight };
}

function mapEntry<K, T>(map: Map<K, Entry<T>>, key: K): Entry<T> {
  let e = map.get(key);
  if (!e) { e = makeEntry<T>(); map.set(key, e); }
  return e;
}

/** Synchronous, non-triggering read - unlike the `*Data()` functions below,
 *  this never kicks a fetch. Use it in render paths that run on every
 *  keystroke/re-render (a computeRows() sort, a row's todo badge); calling
 *  the triggering form there would refire a network call on every render. */
function peek<K, T>(map: Map<K, Entry<T>>, key: K): T | undefined {
  return map.get(key)?.value;
}

// ── project-picker data ─────────────────────────────────────────────────────
const projectGroupsEntry = makeEntry<ProjectGroup[]>();
const projectStatEntries = new Map<string, Entry<ProjectStat>>();

export function projectGroupsData(): CacheRead<ProjectGroup[]> {
  return swr(projectGroupsEntry, async () => (await invoke<ProjectGroup[]>("list_project_groups")) || []);
}

export function projectStatData(path: string): CacheRead<ProjectStat> {
  return swr(mapEntry(projectStatEntries, path), async () => {
    const [mtime, todoCount] = await Promise.all([
      invoke<number>("project_last_activity_at", { cwd: path }).catch(() => 0),
      invoke<number>("count_ai_todos", { cwd: path }).catch(() => 0),
    ]);
    return { mtime, todoCount };
  });
}

/** Non-triggering read for render paths (sort comparators, row badges) that
 *  run on every keystroke - see peek()'s doc. */
export function cachedProjectStat(path: string): ProjectStat | undefined {
  return peek(projectStatEntries, path);
}

// ── model-effort-modal data ─────────────────────────────────────────────────
const settingsEntry = makeEntry<Record<string, unknown>>();
const projectsListEntry = makeEntry<ProjectConfig[]>();
const accountsEntry = makeEntry<Account[]>();
const projectAccountEntries = new Map<string, Entry<string | null>>();
const whitelistEntries = new Map<string, Entry<Character[]>>();

export function settingsData(): CacheRead<Record<string, unknown>> {
  return swr(settingsEntry, async () => (await invoke<Record<string, unknown> | null>("get_settings")) ?? {});
}

export function projectsListData(): CacheRead<ProjectConfig[]> {
  return swr(projectsListEntry, () => api.listProjects());
}

export function accountsListData(): CacheRead<Account[]> {
  return swr(accountsEntry, () => api.listAccounts());
}

/** Backend-normalized preferred-account binding for `cwd` (see
 *  api.resolveProjectAccount). Cached per path, not global. */
export function projectAccountData(cwd: string): CacheRead<string | null> {
  return swr(mapEntry(projectAccountEntries, cwd), () => api.resolveProjectAccount(cwd));
}

export function whitelistCharsData(projectId: string): CacheRead<Character[]> {
  return swr(mapEntry(whitelistEntries, projectId), () => api.resolveWhitelistCharacters(projectId));
}

/** Fire-and-forget: warms every entry above right after boot so the first
 *  "+ New session" tap of the app session is already instant. Best-effort -
 *  a failed fetch just leaves that entry cold for the popup's own read to
 *  retry. Excludes probeModelsAvailability - a live per-account API call. */
export function warmNewSessionCache(): void {
  void projectGroupsData().ready.then((groups) => {
    for (const p of groups) void projectStatData(p.path).ready.catch(() => {});
  }).catch(() => {});
  void settingsData().ready.catch(() => {});
  void accountsListData().ready.catch(() => {});
  void projectsListData().ready.then((projects) => {
    for (const p of projects) void whitelistCharsData(p.id).ready.catch(() => {});
  }).catch(() => {});
}
