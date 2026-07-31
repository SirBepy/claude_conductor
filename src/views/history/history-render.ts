import { html } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import { showView } from "../../shared/navigation";
import { escapeHtml } from "../../shared/escape-html";
import { cwdToProjectName } from "../sessions/sessions-helpers";
import { modelBatteryHtml } from "../sessions/sidebar-row-visuals";
import { hydrateProjectTechIcons, hydrateCharacterAvatars } from "../../shared/projects";
import type { HistoryEntry } from "../../types/ipc.generated";
import { hasActiveFilters, dateBucket, formatTime, historyLeadingVisual, type HistoryFilters } from "./history-helpers";

export function renderList(
  listEl: HTMLElement,
  entries: HistoryEntry[],
  filters: HistoryFilters,
  selectedId: string | null,
): void {
  if (entries.length === 0) {
    listEl.innerHTML = `<li class="history-empty-row">${
      hasActiveFilters(filters) ? "No matches" : "No past sessions"
    }</li>`;
    return;
  }

  const html: string[] = [];
  let lastBucket = "";
  for (const e of entries) {
    const bucket = dateBucket(e.ended_at ?? e.started_at);
    if (bucket !== lastBucket) {
      lastBucket = bucket;
      html.push(`<li class="history-date-sep" aria-hidden="true">${escapeHtml(bucket)}</li>`);
    }
    const title = e.title || cwdToProjectName(e.cwd);
    const time = escapeHtml(formatTime(e.ended_at ?? e.started_at));
    html.push(
      `<li data-session-id="${escapeHtml(e.session_id)}" class="${
        e.session_id === selectedId ? "active" : ""
      }" title="${time}">
        ${historyLeadingVisual(e)}
        <div class="history-row-text">
          <span class="history-row-title">${escapeHtml(title)}</span>
          <span class="history-row-subtitle">${escapeHtml(cwdToProjectName(e.cwd))}</span>
        </div>
        <span class="history-row-chips">${modelBatteryHtml(e.model ?? "")}</span>
      </li>`,
    );
  }
  listEl.innerHTML = html.join("");
  void hydrateProjectTechIcons(listEl);
  void hydrateCharacterAvatars(listEl);
}

export function renderListLoading(listEl: HTMLElement): void {
  listEl.innerHTML = `<li class="history-loading-row"><span class="history-spinner"></span>Loading sessions&hellip;</li>`;
}

/** Rebuild the project filter's options from everything loaded so far,
 * preserving the current selection. Called after every fetch. */
export function renderProjectFilterOptions(
  selectEl: HTMLSelectElement,
  projectOptions: Map<string, string>,
  currentProjectId: string | null,
): void {
  const current = currentProjectId ?? "";
  const sorted = [...projectOptions.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const opts = [`<option value="">All projects</option>`];
  for (const [id, label] of sorted) {
    opts.push(`<option value="${escapeHtml(id)}"${id === current ? " selected" : ""}>${escapeHtml(label)}</option>`);
  }
  selectEl.innerHTML = opts.join("");
}

export function template() {
  return html`
    <div class="view view-history">
      <div class="view-header">
        <button
          class="icon-btn burger"
          title="Menu"
          data-burger="true"
          @click=${openSidemenu}
        >
          <i class="ph ph-list"></i>
        </button>
        <h2>History</h2>
        <button
          class="icon-btn"
          title="Back to Chats"
          @click=${() => showView("sessions")}
        >
          <i class="ph ph-chats"></i>
        </button>
      </div>
      <div class="view-body" id="history-content">
        <div class="history-filter-bar">
          <input
            id="history-search"
            type="search"
            class="history-filter-input"
            placeholder="Search titles"
          />
          <select id="history-project-filter" class="history-filter-select">
            <option value="">All projects</option>
          </select>
          <select id="history-model-filter" class="history-filter-select">
            <option value="">All models</option>
            <option value="haiku">Haiku</option>
            <option value="sonnet">Sonnet</option>
            <option value="opus">Opus</option>
            <option value="fable">Fable</option>
          </select>
          <div class="history-date-range">
            <input id="history-date-from" type="date" class="history-filter-input" title="From date" />
            <span class="history-date-range-sep">&ndash;</span>
            <input id="history-date-to" type="date" class="history-filter-input" title="To date" />
          </div>
        </div>
        <div class="history-layout">
          <aside class="history-sidebar">
            <ul id="history-list"></ul>
          </aside>
          <main class="history-pane">
            <div class="history-empty">Pick a past session</div>
          </main>
        </div>
      </div>
    </div>
  `;
}
