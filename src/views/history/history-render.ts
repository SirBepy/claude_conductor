import { html } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import { showView } from "../../shared/navigation";
import { escapeHtml } from "../../shared/escape-html";
import { cwdToProjectName } from "../sessions/sessions-helpers";
import { modelBatteryHtml } from "../sessions/sidebar-row-visuals";
import { hydrateProjectTechIcons, hydrateCharacterAvatars } from "../../shared/projects";
import type { HistoryEntry } from "../../types/ipc.generated";
import { dateBucket, formatTime, historyLeadingVisual } from "./history-helpers";

export function renderList(
  listEl: HTMLElement,
  entries: HistoryEntry[],
  selectedId: string | null,
): void {
  if (entries.length === 0) {
    listEl.innerHTML = `<li class="history-empty-row">No past sessions</li>`;
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
        <button
          class="icon-btn history-back"
          id="historyBackBtn"
          title="Back to list"
        >
          <i class="ph ph-arrow-left"></i>
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
