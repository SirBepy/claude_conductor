import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { showView } from "../../shared/navigation";
import { ChatRenderer } from "../../shared/chat/chat-renderer";
import { sessionEvents } from "../../shared/chat/event-store";
import { showChatLoadingOverlay } from "../../shared/chat/chat-loading";
import { setPrReviewCwdProvider } from "../../shared/chat/pr-review-modal";
import { queueHistoryResume } from "../sessions/sessions";
import { openChangeAccountModal } from "../../shared/change-account-modal";
import "../../shared/chat/chat.css";
import "../sessions/sessions.css";
import "../sessions/session-avatar.css";
import "../sessions/session-list.css";
import "../sessions/session-statusbar.css";
import "./history.css";
import type { HistoryEntry } from "../../types/ipc.generated";
import { cwdToProjectName } from "../sessions/sessions-helpers";
import { projBadgeHtml, modelBatteryHtml } from "../sessions/sidebar-row-visuals";
import { hydrateProjectTechIcons, hydrateCharacterAvatars } from "../../shared/projects";
import { characterForSessionId, characterIconUrl, loadSessionCharacters } from "../sessions/session-characters";
import { SessionHeader } from "../sessions/session-header";
import { SessionStatusbar } from "../sessions/session-statusbar";

interface HistoryFilters {
  search: string;
  projectId: string | null;
  model: string | null;
  dateFrom: string | null;
  dateTo: string | null;
}

interface HistoryState {
  mountId: number;
  entries: HistoryEntry[];
  filters: HistoryFilters;
  selectedId: string | null;
  renderer: ChatRenderer | null;
  statusbar: SessionStatusbar | null;
  // project_id -> display label, accumulated across every fetch this mount so
  // the dropdown doesn't shrink to "1 option" once the user filters by project.
  projectOptions: Map<string, string>;
}

function emptyFilters(): HistoryFilters {
  return { search: "", projectId: null, model: null, dateFrom: null, dateTo: null };
}

let state: HistoryState = {
  mountId: 0,
  entries: [],
  filters: emptyFilters(),
  selectedId: null,
  renderer: null,
  statusbar: null,
  projectOptions: new Map(),
};
let nextMountId = 1;
let _pendingSelect: string | null = null;
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Open a specific past session read-only on the next History-view mount. Used
 * by the session-detail "Open in chats" CTA when the chat is already closed.
 */
export function queueHistorySelect(sessionId: string): void {
  _pendingSelect = sessionId;
}

/** Local midnight -> RFC3339, so a date filter is inclusive of the user's
 * whole calendar day rather than a UTC-shifted slice of it. */
function startOfDayIso(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00`).toISOString();
}
function endOfDayIso(dateStr: string): string {
  return new Date(`${dateStr}T23:59:59.999`).toISOString();
}

function hasActiveFilters(f: HistoryFilters): boolean {
  return !!(f.search || f.projectId || f.model || f.dateFrom || f.dateTo);
}

async function fetchEntries(): Promise<void> {
  const f = state.filters;
  try {
    state.entries = (await invoke<HistoryEntry[]>("list_history", {
      projectId: f.projectId,
      search: f.search.trim() || null,
      limit: 200,
      offset: 0,
      modelFilter: f.model,
      dateFrom: f.dateFrom ? startOfDayIso(f.dateFrom) : null,
      dateTo: f.dateTo ? endOfDayIso(f.dateTo) : null,
    })) || [];
    for (const e of state.entries) {
      if (e.project_id) state.projectOptions.set(e.project_id, cwdToProjectName(e.cwd));
    }
  } catch (err) {
    console.error("[history] list_history failed", err);
    state.entries = [];
  }
}

function dateBucket(secs: number | bigint | null | undefined): string {
  if (!secs) return "Unknown date";
  const n = typeof secs === "bigint" ? Number(secs) : secs;
  if (!n) return "Unknown date";
  const d = new Date(n * 1000);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday.getTime() - 86400_000);
  if (d >= startOfToday) return "Today";
  if (d >= startOfYesterday) return "Yesterday";
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Historical equivalent of sessions-helpers' statusDotClass, mapping the
 * transcript's last `<cc-status:..>` marker onto the same st-* vocabulary.
 * "done" reads as the calm st-your-turn check, never the "unread" st-done
 * accent - a closed session has nothing left to notify about. */
function historyStatusDotClass(status: string | null): string | null {
  switch (status) {
    case "question": return "st-question";
    case "working": return "st-working";
    case "waiting": return "st-waiting";
    case "done": return "st-your-turn";
    default: return null;
  }
}

/** Leading visual for a row: character portrait when one resolves for this
 * session id, else the plain project badge - never a status icon. A closed
 * session's last-turn status isn't a useful row-level signal, so no ring
 * tint either; mirrors draftLeadingVisual's charId-or-fallback shape in
 * sidebar-row-visuals.ts. */
function historyLeadingVisual(e: HistoryEntry): string {
  const charId = characterForSessionId(e.session_id);
  if (!charId) return projBadgeHtml(e.cwd, "history-proj-icon");
  const id = escapeHtml(charId);
  const url = characterIconUrl(charId);
  const preload = url ? ` src="${escapeHtml(url)}" data-hydrated="${id}"` : "";
  const avatarHtml = `<span class="session-avatar">
          <img class="char-avatar session-char-backdrop" data-character-id="${id}"${preload} alt="" aria-hidden="true">
          <img class="char-avatar session-char-img" data-character-id="${id}"${preload} alt="${id}">
        </span>`;
  const badge = projBadgeHtml(e.cwd, "session-proj-badge");
  return `<span class="session-avatar-wrap">${avatarHtml}${badge}</span>`;
}

function renderList(listEl: HTMLElement): void {
  if (state.entries.length === 0) {
    listEl.innerHTML = `<li class="history-empty-row">${
      hasActiveFilters(state.filters) ? "No matches" : "No past sessions"
    }</li>`;
    return;
  }

  const html: string[] = [];
  let lastBucket = "";
  for (const e of state.entries) {
    const bucket = dateBucket(e.ended_at ?? e.started_at);
    if (bucket !== lastBucket) {
      lastBucket = bucket;
      html.push(`<li class="history-date-sep" aria-hidden="true">${escapeHtml(bucket)}</li>`);
    }
    const title = e.title || cwdToProjectName(e.cwd);
    const time = escapeHtml(formatTime(e.ended_at ?? e.started_at));
    html.push(
      `<li data-session-id="${escapeHtml(e.session_id)}" class="${
        e.session_id === state.selectedId ? "active" : ""
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

function renderListLoading(listEl: HTMLElement): void {
  listEl.innerHTML = `<li class="history-loading-row"><span class="history-spinner"></span>Loading sessions&hellip;</li>`;
}

function formatTime(secs: number | bigint | null | undefined): string {
  if (secs === null || secs === undefined) return "";
  const n = typeof secs === "bigint" ? Number(secs) : secs;
  if (!n) return "";
  const d = new Date(n * 1000);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Rebuild the project filter's options from everything loaded so far,
 * preserving the current selection. Called after every fetch. */
function renderProjectFilterOptions(selectEl: HTMLSelectElement): void {
  const current = state.filters.projectId ?? "";
  const sorted = [...state.projectOptions.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const opts = [`<option value="">All projects</option>`];
  for (const [id, label] of sorted) {
    opts.push(`<option value="${escapeHtml(id)}"${id === current ? " selected" : ""}>${escapeHtml(label)}</option>`);
  }
  selectEl.innerHTML = opts.join("");
}

async function selectHistorySession(sessionId: string, pane: HTMLElement): Promise<void> {
  const myMount = state.mountId;
  state.selectedId = sessionId;
  state.statusbar?.destroy();
  state.statusbar = null;

  const entry = state.entries.find(e => e.session_id === sessionId);

  pane.innerHTML = `
    <div class="session-statusbar-host"></div>
    <div class="session-messages"></div>
    <div class="history-session-actions">
      <button class="btn-continue-chat">
        <i class="ph ph-play"></i> Continue this chat
      </button>
    </div>
  `;

  const header = new SessionHeader({
    title: entry?.title || cwdToProjectName(entry?.cwd ?? ""),
    meta: cwdToProjectName(entry?.cwd ?? ""),
  });
  const charId = entry ? characterForSessionId(entry.session_id) : null;
  header.bindSession({
    sessionId,
    readOnly: true,
    charId,
    charUrl: charId ? characterIconUrl(charId) : null,
    charStatus: entry ? (historyStatusDotClass(entry.last_status) ?? "") : "",
    cwd: entry?.cwd ?? null,
  });
  pane.insertBefore(header.el, pane.firstChild);
  void hydrateCharacterAvatars(pane);

  const sbHost = pane.querySelector<HTMLElement>(".session-statusbar-host");
  if (sbHost) {
    // Fixed, minimal row set for replay: only chips fed purely from replayed
    // turn_usage meta (model, cost). No git/drain/servers/ai_todos/context/
    // counts chips - those poll a LIVE instance that no longer exists for a
    // closed session, so they're simply left out of the rows rather than
    // fetched and shown empty.
    state.statusbar = new SessionStatusbar(sbHost, null, [["model", "cost"]], {
      cwd: entry?.cwd ?? null,
      sessionId,
      readOnly: true,
      sessionModel: entry?.model ?? null,
      hideZero: true,
    });
  }

  if (entry) {
    pane.querySelector<HTMLButtonElement>(".btn-continue-chat")?.addEventListener("click", async () => {
      // A historical session predates account tracking (or was never
      // associated with one), so ask which account future turns should run
      // under instead of silently falling back to the app's default account
      // - same reasoning as the manual-takeover confirmation.
      const accountId = await openChangeAccountModal({ currentId: null, title: "Continue as which account?" });
      if (!accountId) return;
      try {
        await invoke<void>("register_historical_session", { sessionId: entry.session_id, cwd: entry.cwd, accountId });
      } catch (err) {
        console.error("[history] register_historical_session failed", err);
      }
      queueHistoryResume(entry.session_id);
      showView("sessions");
    });
  }

  if (state.renderer) state.renderer.detach();
  const messagesEl = pane.querySelector<HTMLElement>(".session-messages");
  if (!messagesEl) return;
  const renderer = new ChatRenderer(messagesEl);
  state.renderer = renderer;
  const sbForRenderer = state.statusbar;
  if (sbForRenderer) {
    renderer.onMetaUpdate = (meta) => {
      if (state.statusbar === sbForRenderer) sbForRenderer.updateMeta(meta);
    };
  }
  // Let the PR-preview modal's git IPC calls resolve this historical
  // session's working directory.
  setPrReviewCwdProvider(() => (entry?.cwd ? String(entry.cwd) : null));

  await renderer.attach(sessionId);
  if (state.mountId !== myMount || state.selectedId !== sessionId) {
    renderer.detach();
    return;
  }
  // Paginated load via the shared event store: last ~20 messages now, older
  // ones fetched on scroll by the renderer's paginator (load_history_page under
  // the hood). Passing the entry's cwd lets the backend locate the transcript
  // directly instead of scanning every project dir. A cache hit renders with no
  // IPC; a miss shows the loading overlay while the first page loads.
  const cwd = entry?.cwd ? String(entry.cwd) : undefined;
  const overlay = sessionEvents.isLoaded(sessionId) ? null : showChatLoadingOverlay(messagesEl);
  try {
    await renderer.loadFromStore(cwd);
    if (state.mountId !== myMount || state.selectedId !== sessionId) {
      renderer.detach();
      return;
    }
  } catch (err) {
    console.error("[history] loadFromStore failed", err);
    pane.innerHTML = `<div class="history-empty">Failed to load: ${escapeHtml(String(err))}</div>`;
  } finally {
    overlay?.remove();
  }
}

export async function renderHistoryView(root: HTMLElement): Promise<() => void> {
  const myMount = nextMountId++;
  state = {
    mountId: myMount,
    entries: [],
    filters: emptyFilters(),
    selectedId: null,
    renderer: null,
    statusbar: null,
    projectOptions: new Map(),
  };

  render(template(), root);

  const listEl = root.querySelector<HTMLElement>("#history-list");
  const pane = root.querySelector<HTMLElement>(".history-pane");
  const searchInput = root.querySelector<HTMLInputElement>("#history-search");
  const projectSelect = root.querySelector<HTMLSelectElement>("#history-project-filter");
  const modelSelect = root.querySelector<HTMLSelectElement>("#history-model-filter");
  const dateFromInput = root.querySelector<HTMLInputElement>("#history-date-from");
  const dateToInput = root.querySelector<HTMLInputElement>("#history-date-to");

  if (!listEl || !pane) {
    console.error("[history] view template missing expected nodes");
    return () => { /* no-op */ };
  }

  void loadSessionCharacters();
  renderListLoading(listEl);
  await fetchEntries();
  if (state.mountId !== myMount) return () => { /* superseded */ };
  renderList(listEl);
  if (projectSelect) renderProjectFilterOptions(projectSelect);

  // If session-detail asked us to open a specific closed chat, select it now.
  // Otherwise auto-select the most recent session so the pane isn't blank.
  const pendingOrFirst = _pendingSelect ?? state.entries[0]?.session_id ?? null;
  if (pendingOrFirst) {
    if (_pendingSelect) _pendingSelect = null;
    const li = listEl.querySelector<HTMLLIElement>(`li[data-session-id="${CSS.escape(pendingOrFirst)}"]`);
    if (li) {
      listEl.querySelectorAll("li[data-session-id]").forEach((el) => el.classList.remove("active"));
      li.classList.add("active");
      li.scrollIntoView({ block: "center" });
    }
    void selectHistorySession(pendingOrFirst, pane);
  }

  // Re-query the list with the current filters, showing the loading row while
  // in flight. Shared by every filter control below.
  const refetchAndRender = async (): Promise<void> => {
    const myFetch = state.mountId;
    renderListLoading(listEl);
    await fetchEntries();
    if (state.mountId !== myFetch) return;
    renderList(listEl);
    if (projectSelect) renderProjectFilterOptions(projectSelect);
  };

  searchInput?.addEventListener("input", () => {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      state.filters.search = searchInput.value;
      void refetchAndRender();
    }, 250);
  });
  projectSelect?.addEventListener("change", () => {
    state.filters.projectId = projectSelect.value || null;
    void refetchAndRender();
  });
  modelSelect?.addEventListener("change", () => {
    state.filters.model = modelSelect.value || null;
    void refetchAndRender();
  });
  dateFromInput?.addEventListener("change", () => {
    state.filters.dateFrom = dateFromInput.value || null;
    void refetchAndRender();
  });
  dateToInput?.addEventListener("change", () => {
    state.filters.dateTo = dateToInput.value || null;
    void refetchAndRender();
  });

  listEl.addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLLIElement>("li[data-session-id]");
    if (!li) return;
    const id = li.dataset.sessionId;
    if (id) {
      // Update active class immediately without re-rendering the whole list.
      listEl.querySelectorAll("li[data-session-id]").forEach(el => el.classList.remove("active"));
      li.classList.add("active");
      void selectHistorySession(id, pane);
    }
  });

  return () => {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    if (state.renderer) {
      state.renderer.detach();
      state.renderer = null;
    }
    state.statusbar?.destroy();
    state.statusbar = null;
    state.selectedId = null;
  };
}

function template() {
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
