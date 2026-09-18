import { html, render, type TemplateResult } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import { openSidemenu } from "../../shared/sidemenu";
import { wireKebabMenu, closeKebabMenu } from "../../shared/kebab-menu";
import "../../shared/kebab-menu.css";
import "./projects.css";
import { setTokenHistory } from "../../shared/state";
import { openProjectDetail } from "../../shared/navigation";
import { renderAvatar, hydrateCharacterAvatars, hydrateProjectTechIcons, type Avatar } from "../../shared/projects";
import { formatTokens } from "../../shared/tokens";
import { timeAgo } from "../../shared/time";
import { showToast } from "../../shared/toast";
import { api, type ProjectGroup } from "../../shared/api";
import type { ProjectsSortBy } from "../../types/ipc.generated";

type LoadState = "loading" | "loaded" | "error";

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
  render(template(), mounted);
}

async function load(): Promise<void> {
  loadState = "loading";
  draw();
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

function cardTemplate(g: ProjectGroup): TemplateResult {
  const displayName = g.parent_segment ? `${g.name} · ${g.parent_segment}` : g.name;
  const avatar = renderAvatar(g.avatar as Avatar, g.path);
  const tokens = formatTokens(Number(g.tokens_7d) || 0);
  const lastSeen = g.last_active_at ? timeAgo(g.last_active_at) : "";
  const cwd = g.path;
  const activate = (): void => openProjectDetail(cwd);
  return html`
    <div
      class="project-card v-focusable"
      role="button"
      tabindex="0"
      data-project-id=${g.id || ""}
      @click=${activate}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      }}
    >
      <div class="avatar">${unsafeHTML(avatar)}</div>
      <div class="body">
        <div class="name">${displayName}</div>
        ${g.live || g.any_remote || g.any_automated
          ? html`
            <div class="proj-tags">
              ${g.live
                ? html`<span class="proj-tag proj-tag-live" title="${g.live} live" aria-label="${g.live} live"><span class="proj-tag-dot"></span>${g.live}</span>`
                : ""}
              ${g.any_remote
                ? html`<span class="proj-tag" title="remote" aria-label="remote"><i class="ph ph-device-mobile"></i>remote</span>`
                : ""}
              ${g.any_automated
                ? html`<span class="proj-tag" title="auto" aria-label="auto"><i class="ph ph-gear"></i>auto</span>`
                : ""}
            </div>
          `
          : ""}
        <div class="tokens">${tokens} tokens${lastSeen ? ` · ${lastSeen}` : ""}</div>
      </div>
    </div>
  `;
}

function bodyTemplate(): TemplateResult {
  if (loadState === "loading") {
    return html`
      <div id="projects-list" class="projects-list">
        ${[0, 1, 2, 3].map(() => html`<div class="v-skeleton project-skeleton"></div>`)}
      </div>
    `;
  }

  if (loadState === "error") {
    return html`
      <div class="v-empty">
        <i class="ph ph-warning v-empty-icon"></i>
        <div class="v-empty-title">Couldn't load projects</div>
        <div class="v-empty-hint">Something went wrong talking to the backend. Retry below.</div>
        <button class="btn-secondary" @click=${() => void load()}>Retry</button>
      </div>
    `;
  }

  if (allGroups.length === 0) {
    return html`
      <div class="v-empty">
        <i class="ph ph-folder-open v-empty-icon"></i>
        <div class="v-empty-title">No projects yet</div>
        <div class="v-empty-hint">Projects appear here once you use Claude Code in a folder.</div>
      </div>
    `;
  }

  const sorted = sortProjectGroups(allGroups, sortBy);
  const rows = filterProjectGroups(sorted, query);
  const isFiltering = query.trim().length > 0;

  return html`
    ${isFiltering ? html`<div class="projects-count">${rows.length} of ${allGroups.length}</div>` : ""}
    ${rows.length === 0
      ? html`
        <div class="v-empty">
          <i class="ph ph-magnifying-glass v-empty-icon"></i>
          <div class="v-empty-title">No matches for "${query}"</div>
        </div>
      `
      : html`<div id="projects-list" class="projects-list">${rows.map(cardTemplate)}</div>`}
  `;
}

function headerTemplate(): TemplateResult {
  return html`
    <div class="view-header">
      <button class="icon-btn burger" title="Menu" data-burger="true" @click=${openSidemenu}>
        <i class="ph ph-list"></i>
      </button>
      <h2>Projects</h2>
      <div class="view-header-actions">
        <div class="menu-anchor">
          <button class="icon-btn" id="projects-more" title="More options">
            <i class="ph ph-dots-three-vertical"></i>
          </button>
          <div class="menu-popover hidden" id="projects-menu">
            <button class="menu-item" id="projects-refresh" @click=${onRefreshClick}>
              <i class="ph ph-arrow-clockwise"></i> Refresh
            </button>
            <button class="menu-item" id="projects-rebuild" @click=${onRebuildClick} ?disabled=${backfillRunning}>
              <i class="ph ph-arrows-clockwise"></i> Rebuild history
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function template(): TemplateResult {
  return html`
    <div class="view view-projects">
      ${headerTemplate()}
      <div class="view-body">
        <div class="projects-toolbar">
          <div class="projects-search">
            <i class="ph ph-magnifying-glass"></i>
            <input
              type="search"
              id="projectsSearchInput"
              placeholder="Search projects..."
              .value=${query}
              autocomplete="off"
              spellcheck="false"
              @input=${onSearchInput}
              @keydown=${onSearchKeydown}
            />
          </div>
          <select id="projectsSortSelect" class="projects-sort-select" .value=${sortBy} @change=${onSortChange}>
            <option value="recent">Recently used</option>
            <option value="name">Name</option>
            <option value="live">Live now</option>
            <option value="tokens">Tokens (7d)</option>
          </select>
        </div>
        ${backfillStatusMsg ? html`<div class="projects-backfill-status" aria-live="polite">${backfillStatusMsg}</div>` : ""}
        ${bodyTemplate()}
      </div>
    </div>
  `;
}

export async function renderProjectsView(root: HTMLElement): Promise<() => void> {
  mounted = root;
  loadState = "loading";
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
