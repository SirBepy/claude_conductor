import { html, type TemplateResult } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import { openSidemenu } from "../../shared/sidemenu";
import { openProjectDetail } from "../../shared/navigation";
import { renderAvatar, type Avatar } from "../../shared/projects";
import { formatTokens } from "../../shared/tokens";
import { timeAgo } from "../../shared/time";
import type { ProjectGroup } from "../../shared/api";
import type { ProjectsSortBy } from "../../types/ipc.generated";
import { sortProjectGroups, filterProjectGroups, type LoadState } from "./projects";

/** Snapshot of projects.ts's module state plus the event handlers it wires up -
 *  passed in explicitly so this file holds no module state of its own
 *  (extracted from projects.ts, todo 961). */
export interface ProjectsViewState {
  loadState: LoadState;
  allGroups: ProjectGroup[];
  sortBy: ProjectsSortBy;
  query: string;
  backfillRunning: boolean;
  backfillStatusMsg: string | null;
  onRetry: () => void;
  onRefreshClick: (e: Event) => void;
  onRebuildClick: (e: Event) => void;
  onSearchInput: (e: Event) => void;
  onSearchKeydown: (e: KeyboardEvent) => void;
  onSortChange: (e: Event) => void;
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

function bodyTemplate(state: ProjectsViewState): TemplateResult {
  if (state.loadState === "loading") {
    return html`
      <div id="projects-list" class="projects-list">
        ${[0, 1, 2, 3].map(() => html`<div class="v-skeleton project-skeleton"></div>`)}
      </div>
    `;
  }

  if (state.loadState === "error") {
    return html`
      <div class="v-empty">
        <i class="ph ph-warning v-empty-icon"></i>
        <div class="v-empty-title">Couldn't load projects</div>
        <div class="v-empty-hint">Something went wrong talking to the backend. Retry below.</div>
        <button class="btn-secondary" @click=${state.onRetry}>Retry</button>
      </div>
    `;
  }

  if (state.allGroups.length === 0) {
    return html`
      <div class="v-empty">
        <i class="ph ph-folder-open v-empty-icon"></i>
        <div class="v-empty-title">No projects yet</div>
        <div class="v-empty-hint">Projects appear here once you use Claude Code in a folder.</div>
      </div>
    `;
  }

  const sorted = sortProjectGroups(state.allGroups, state.sortBy);
  const rows = filterProjectGroups(sorted, state.query);
  const isFiltering = state.query.trim().length > 0;

  return html`
    ${isFiltering ? html`<div class="projects-count">${rows.length} of ${state.allGroups.length}</div>` : ""}
    ${rows.length === 0
      ? html`
        <div class="v-empty">
          <i class="ph ph-magnifying-glass v-empty-icon"></i>
          <div class="v-empty-title">No matches for "${state.query}"</div>
        </div>
      `
      : html`<div id="projects-list" class="projects-list">${rows.map(cardTemplate)}</div>`}
  `;
}

function headerTemplate(state: ProjectsViewState): TemplateResult {
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
            <button class="menu-item" id="projects-refresh" @click=${state.onRefreshClick}>
              <i class="ph ph-arrow-clockwise"></i> Refresh
            </button>
            <button class="menu-item" id="projects-rebuild" @click=${state.onRebuildClick} ?disabled=${state.backfillRunning}>
              <i class="ph ph-arrows-clockwise"></i> Rebuild history
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function template(state: ProjectsViewState): TemplateResult {
  return html`
    <div class="view view-projects">
      ${headerTemplate(state)}
      <div class="view-body">
        <div class="view-body-inner">
          <div class="projects-toolbar">
            <div class="projects-search">
              <i class="ph ph-magnifying-glass"></i>
              <input
                type="search"
                id="projectsSearchInput"
                placeholder="Search projects..."
                .value=${state.query}
                autocomplete="off"
                spellcheck="false"
                @input=${state.onSearchInput}
                @keydown=${state.onSearchKeydown}
              />
            </div>
            <select id="projectsSortSelect" class="projects-sort-select" .value=${state.sortBy} @change=${state.onSortChange}>
              <option value="recent">Recently used</option>
              <option value="name">Name</option>
              <option value="live">Live now</option>
              <option value="tokens">Tokens (7d)</option>
            </select>
          </div>
          ${state.backfillStatusMsg ? html`<div class="projects-backfill-status" aria-live="polite">${state.backfillStatusMsg}</div>` : ""}
          ${bodyTemplate(state)}
        </div>
      </div>
    </div>
  `;
}
