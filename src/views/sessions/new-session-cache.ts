/** Stale-while-revalidate cache for the new-session popup chain's data. Every
 *  read returns what's cached instantly and kicks a deduped background
 *  refetch that patches in place - self-healing after any external change,
 *  no invalidation event to wire up. warmNewSessionCache() primes it at boot.
 *
 *  The phone revalidates differently: one `new_session_bundle` request
 *  refreshes every entry at once, instead of one request per entry per
 *  project. Its tunnel caps out at 6 concurrent requests, so the per-project
 *  fan-out queued the read a tap was actually waiting on behind ~80 others.
 *  The last bundle is also kept in localStorage, so a reloaded or freshly
 *  opened phone app paints the whole new-chat flow from it before the
 *  network answers. */

import { api } from "../../shared/api";
import type { Account, Character, ProjectConfig } from "../../shared/api";
import { invoke } from "../../shared/ipc";
import { isRemote } from "../../shared/transport";
import type { ClaudeMdScope, ProjectGroup } from "../../types/ipc.generated";
import { isNoProjectPath, NO_PROJECT_LABEL } from "../../shared/no-project";

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
  if (isRemote()) return remoteRead(entry, fetcher);
  return ownFetch(entry, fetcher);
}

function ownFetch<T>(entry: Entry<T>, fetcher: () => Promise<T>): CacheRead<T> {
  if (!entry.inflight) {
    entry.inflight = fetcher()
      .then((v) => { entry.value = v; entry.inflight = null; return v; })
      .catch((e) => { entry.inflight = null; throw e; });
  }
  return { cached: entry.value, ready: entry.inflight };
}

/** Phone path. A cached entry revalidates through the bundle (one request for
 *  everything); an uncached one still fetches on its own so a cold modal
 *  never waits on the bundle's slower whole-project scan, and kicks the
 *  bundle alongside so every later read is warm. */
function remoteRead<T>(entry: Entry<T>, fetcher: () => Promise<T>): CacheRead<T> {
  hydrateFromDisk();
  const bundle = refreshNewSessionBundle();
  bundle.catch(() => { /* each read below has its own fallback */ });
  if (entry.value !== undefined) {
    return {
      cached: entry.value,
      ready: bundle.then(() => entry.value ?? fetcher(), () => entry.value as T),
    };
  }
  return ownFetch(entry, fetcher);
}

function mapEntry<K, T>(map: Map<K, Entry<T>>, key: K): Entry<T> {
  let e = map.get(key);
  if (!e) { e = makeEntry<T>(); map.set(key, e); }
  return e;
}

/** Resolves a CacheRead<T> to its value: the cached value synchronously if
 *  present, otherwise awaits the in-flight/triggered fetch, falling back to
 *  `fallback` on rejection. */
export async function resolveCached<T>(read: CacheRead<T>, fallback: T): Promise<T> {
  if (read.cached !== undefined) return read.cached;
  return read.ready.catch(() => fallback);
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

/** The label lives on `name` from this point on, so the picker rows,
 *  favourites rail and Ctrl+Shift strip never each check the path. */
function labelGroups(groups: ProjectGroup[]): ProjectGroup[] {
  return groups.map((g) => (isNoProjectPath(g.path) ? { ...g, name: NO_PROJECT_LABEL } : g));
}

export function projectGroupsData(): CacheRead<ProjectGroup[]> {
  return swr(projectGroupsEntry, async () =>
    labelGroups((await invoke<ProjectGroup[]>("list_project_groups")) || []));
}

const ZERO_STAT: ProjectStat = { mtime: 0, todoCount: 0 };

export function projectStatData(path: string): CacheRead<ProjectStat> {
  const entry = mapEntry(projectStatEntries, path);
  if (isRemote()) {
    // Badges only, never something a tap waits on - so even a cold entry
    // waits for the bundle rather than adding 2 requests per project.
    hydrateFromDisk();
    return {
      cached: entry.value,
      ready: refreshNewSessionBundle().then(() => entry.value ?? ZERO_STAT, () => entry.value ?? ZERO_STAT),
    };
  }
  return swr(entry, async () => {
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

// ── location-picker data ────────────────────────────────────────────────────
const scopeEntries = new Map<string, Entry<ClaudeMdScope[]>>();

/** CLAUDE.md start-folder scopes for one worktree. Cached so picking a
 *  project the cache already knows decides the location step without a
 *  round trip (it used to scan on every tap). */
export function claudeMdScopesData(worktreePath: string): CacheRead<ClaudeMdScope[]> {
  return swr(mapEntry(scopeEntries, worktreePath), () =>
    invoke<ClaudeMdScope[]>("list_claude_md_scopes", { worktreePath }));
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
  // Not in the bundle (resolved per character pool), so this keeps its own
  // fetch on the phone too.
  return ownFetch(mapEntry(whitelistEntries, projectId), () => api.resolveWhitelistCharacters(projectId));
}

// ── phone bundle ────────────────────────────────────────────────────────────

/** `new_session_bundle`'s response (daemon/methods/registry/new_session_bundle.rs). */
export interface NewSessionBundle {
  groups: ProjectGroup[];
  stats: Record<string, ProjectStat>;
  /** Keyed by the worktree path the location step scans first. */
  scopes: Record<string, ClaudeMdScope[]>;
  projectAccounts: Record<string, string | null>;
  projects: ProjectConfig[];
  settings: Record<string, unknown>;
  accounts: Account[];
}

export const BUNDLE_STORAGE_KEY = "cc_new_session_bundle_v1";

let bundleInflight: Promise<void> | null = null;
let bundleLandedAt = 0;
let hydrated = false;

/** A bundle this fresh answers every read on its own. Without it the picker
 *  re-fired the whole daemon scan as soon as the first bundle landed, since
 *  its stat warm-up runs right after the list arrives. */
const BUNDLE_FRESH_MS = 5_000;

/** Seeds every entry from one bundle. Per-path maps are replaced wholesale,
 *  except entries the bundle doesn't cover (another worktree's scopes, a
 *  path outside the project list), which keep what they had. */
export function applyNewSessionBundle(b: NewSessionBundle): void {
  projectGroupsEntry.value = labelGroups(b.groups ?? []);
  settingsEntry.value = b.settings ?? {};
  projectsListEntry.value = b.projects ?? [];
  accountsEntry.value = b.accounts ?? [];
  for (const [path, stat] of Object.entries(b.stats ?? {})) mapEntry(projectStatEntries, path).value = stat;
  for (const [path, scopes] of Object.entries(b.scopes ?? {})) mapEntry(scopeEntries, path).value = scopes;
  for (const [path, acct] of Object.entries(b.projectAccounts ?? {})) mapEntry(projectAccountEntries, path).value = acct;
}

/** Reads the last bundle back from localStorage once per page load. Kept
 *  across reloads on purpose: a reopened phone app shows the new-chat flow
 *  instantly from it instead of waiting on a cold tunnel. */
function hydrateFromDisk(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = localStorage.getItem(BUNDLE_STORAGE_KEY);
    if (raw) applyNewSessionBundle(JSON.parse(raw) as NewSessionBundle);
  } catch { /* corrupt or unavailable storage: start cold */ }
}

/** One deduped bundle request; resolves once every entry is patched. */
export function refreshNewSessionBundle(): Promise<void> {
  if (!bundleInflight && Date.now() - bundleLandedAt < BUNDLE_FRESH_MS) return Promise.resolve();
  if (!bundleInflight) {
    bundleInflight = invoke<NewSessionBundle>("new_session_bundle")
      .then((b) => {
        applyNewSessionBundle(b);
        bundleLandedAt = Date.now();
        try { localStorage.setItem(BUNDLE_STORAGE_KEY, JSON.stringify(b)); }
        catch { /* quota/private mode: in-memory still works */ }
      })
      .finally(() => { bundleInflight = null; });
  }
  return bundleInflight;
}

/** Fire-and-forget: warms every entry above right after boot so the first
 *  "+ New session" tap of the app session is already instant. Best-effort -
 *  a failed fetch just leaves that entry cold for the popup's own read to
 *  retry. Excludes probeModelsAvailability - a live per-account API call. */
export function warmNewSessionCache(): void {
  if (isRemote()) {
    hydrateFromDisk();
    void refreshNewSessionBundle().catch(() => {});
    return;
  }
  void projectGroupsData().ready.then((groups) => {
    for (const p of groups) void projectStatData(p.path).ready.catch(() => {});
  }).catch(() => {});
  void settingsData().ready.catch(() => {});
  void accountsListData().ready.catch(() => {});
  void projectsListData().ready.then((projects) => {
    for (const p of projects) void whitelistCharsData(p.id).ready.catch(() => {});
  }).catch(() => {});
}

/** Test seam. */
export function resetNewSessionCacheForTests(): void {
  for (const e of [projectGroupsEntry, settingsEntry, projectsListEntry, accountsEntry] as Entry<unknown>[]) {
    e.value = undefined;
    e.inflight = null;
  }
  for (const m of [projectStatEntries, scopeEntries, projectAccountEntries, whitelistEntries]) m.clear();
  bundleInflight = null;
  bundleLandedAt = 0;
  hydrated = false;
}
