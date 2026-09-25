import { render } from "lit-html";
import { wireKebabMenu, closeKebabMenu } from "../../shared/kebab-menu";
import "../../shared/kebab-menu.css";
import "./projects.css";
import { setTokenHistory } from "../../shared/state";
import { hydrateCharacterAvatars, hydrateProjectTechIcons } from "../../shared/projects";
import { showToast } from "../../shared/toast";
import { api, type ProjectGroup } from "../../shared/api";
import type { ProjectsSortBy } from "../../types/ipc.generated";
import { template } from "./projects-render";

export type LoadState = "loading" | "loaded" | "error";

let mounted: HTMLElement | null = null;
let allGroups: ProjectGroup[] = [];
let loadState: LoadState = "loading";
let sortBy: ProjectsSortBy = "recent";
let query = "";
let backfillRunning = false;
let backfillStatusMsg: string | null = null;
let disposeKebab: (() => void) | null = null;

/** Pure sort, shared with the tests. Mirrors the four backend sort modes;
 *  "recent" additionally clusters just-started sessions by liveness. */
export function sortProjectGroups(groups: ProjectGroup[], sort: ProjectsSortBy): ProjectGroup[] {
  const lastMs = (g: ProjectGroup): number => g.last_active_at ? Date.parse(g.last_active_at) || 0 : 0;
  const nameOf = (g: ProjectGroup): string => (g.name || "").toLowerCase();
  return [...groups].sort((a, b) => {
    switch (sort) {
      case "name":
        return nameOf(a).localeCompare(nameOf(b));
      case "live":
        if ((b.live || 0) !== (a.live || 0)) return (b.live || 0) - (a.live || 0);
        return lastMs(b) - lastMs(a);
      case "tokens":
        return Number(b.tokens_7d || 0) - Number(a.tokens_7d || 0);
      case "recent":
      default: {
        const aMs = lastMs(a);
        const bMs = lastMs(b);
        const now = Date.now();
        const aJustNow = now - aMs < 60000;
        const bJustNow = now - bMs < 60000;
        if (aJustNow && bJustNow) {
          const liveDiff = (b.live || 0) - (a.live || 0);
          if (liveDiff !== 0) return liveDiff;
          return nameOf(a).localeCompare(nameOf(b));
        }
        return bMs - aMs;
      }
    }
  });
}

/** Client-side name/parent-segment search, case-insensitive. */
export function filterProjectGroups(groups: ProjectGroup[], q: string): ProjectGroup[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return groups;
  return groups.filter(
    (g) =>
      (g.name || "").toLowerCase().includes(needle) ||
      (g.parent_segment || "").toLowerCase().includes(needle),
  );
}

function draw(): void {
  if (!mounted) return;
  render(
    template({
      loadState,
      allGroups,
      sortBy,
      query,
      backfillRunning,
      backfillStatusMsg,
      onRetry: () => void load(),
      onRefreshClick,
      onRebuildClick,
      onSearchInput,
      onSearchKeydown,
      onSortChange,
    }),
    mounted,
  );
}

async function load(): Promise<void> {
  // Only skeleton when nothing's rendered yet - re-skeletoning over already
  // -loaded content is what caused the flash on every live-update event
  // (onHistoryUpdated/onTokenHistoryUpdated/onInstancesChanged fire a lot
  // while actively working, and each one called load()).
  if (allGroups.length === 0) {
    loadState = "loading";
    draw();
  }
  try {
    allGroups = await api.listProjectGroups();
    loadState = "loaded";
  } catch (e) {
    console.error("listProjectGroups failed", e);
    loadState = "error";
  }
  draw();
  const list = mounted?.querySelector<HTMLElement>("#projects-list");
  if (list) {
    void hydrateCharacterAvatars(list);
    void hydrateProjectTechIcons(list);
  }
}

async function runBackfill(): Promise<void> {
  if (backfillRunning) return;
  backfillRunning = true;
  backfillStatusMsg = "Scanning… this may take a while";
  draw();
  try {
    const result = await api.backfillTranscripts();
    backfillStatusMsg = result ? `Done - ${result.processed} new, ${result.skipped} skipped` : "Done";
    const fresh = await api.getTokenHistory();
    setTokenHistory(fresh ?? null);
    await load();
  } catch (e) {
    backfillStatusMsg = "Error: " + (e as Error).message;
  } finally {
    backfillRunning = false;
    draw();
    if (backfillStatusMsg) showToast(backfillStatusMsg);
  }
}

// Re-exported for the app-level subscriptions in shared/boot.ts and the
// post-edit refreshes in project-detail/folder-mapping - both import these by
// name, not just via the sidemenu router.
export async function renderProjectsList(): Promise<void> {
  await load();
}

export function refreshProjectsUI(): void {
  void renderProjectsList();
}

function onSearchInput(e: Event): void {
  query = (e.target as HTMLInputElement).value;
  draw();
}

function onSearchKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape" && query) {
    e.preventDefault();
    e.stopPropagation();
    query = "";
    draw();
  }
}

async function onSortChange(e: Event): Promise<void> {
  sortBy = (e.target as HTMLSelectElement).value as ProjectsSortBy;
  draw();
  try {
    await api.setProjectsSortBy(sortBy);
  } catch (err) {
    console.error("setProjectsSortBy failed", err);
  }
}

function closeMenuFromEvent(e: Event): void {
  const menu = (e.currentTarget as HTMLElement).closest<HTMLElement>(".menu-popover");
  if (menu) closeKebabMenu(menu);
}

function onRefreshClick(e: Event): void {
  closeMenuFromEvent(e);
  void load();
}

function onRebuildClick(e: Event): void {
  closeMenuFromEvent(e);
  void runBackfill();
}

function wireKebab(): void {
  if (!mounted) return;
  const btn = mounted.querySelector<HTMLButtonElement>("#projects-more");
  const menu = mounted.querySelector<HTMLElement>("#projects-menu");
  if (!btn || !menu) return;
  disposeKebab = wireKebabMenu(btn, menu);
}

export async function renderProjectsView(root: HTMLElement): Promise<() => void> {
  mounted = root;
  // Re-mounting after a prior visit already has allGroups warm - keep showing
  // it instead of flashing back to the skeleton (load() below refreshes it).
  if (allGroups.length === 0) loadState = "loading";
  query = "";
  backfillRunning = false;
  backfillStatusMsg = null;
  draw();

  try {
    const s = await api.getSettings();
    sortBy = (s as { projects_sort_by?: ProjectsSortBy } | null)?.projects_sort_by || "recent";
  } catch {
    /* keep the "recent" default */
  }

  await load();
  wireKebab();

  const unsubHistory = api.onHistoryUpdated(() => { void load(); });
  const unsubTokens = api.onTokenHistoryUpdated(() => { void load(); });
  const unsubInstances = api.onInstancesChanged(() => { void load(); });

  return () => {
    mounted = null;
    try { unsubHistory(); } catch { /* ignore */ }
    try { unsubTokens(); } catch { /* ignore */ }
    try { unsubInstances(); } catch { /* ignore */ }
    if (disposeKebab) { disposeKebab(); disposeKebab = null; }
  };
}
