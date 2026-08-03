import { render } from "lit-html";
import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { showView } from "../../shared/navigation";
import { ChatRenderer } from "../../shared/chat/chat-renderer";
import { sessionEvents } from "../../shared/chat/event-store";
import { showChatLoadingOverlay } from "../../shared/chat/chat-loading";
import { setPrReviewCwdProvider } from "../../shared/chat/pr-review-modal";
import { queueHistoryResume } from "../sessions/sessions";
import { openChangeAccountModal } from "../../shared/change-account-modal";
import { showToast } from "../../shared/toast";
import { isRemote } from "../../shared/transport";
import "../../shared/chat/chat.css";
import "../sessions/sessions.css";
import "../sessions/session-avatar.css";
import "../sessions/session-list.css";
import "../sessions/session-row-portrait.css";
import "../sessions/session-statusbar.css";
import "./history.css";
import type { HistoryEntry } from "../../types/ipc.generated";
import { cwdToProjectName } from "../sessions/sessions-helpers";
import { hydrateCharacterAvatars } from "../../shared/projects";
import { characterForSessionId, characterIconUrl, loadSessionCharacters } from "../sessions/session-characters";
import { SessionHeader } from "../sessions/session-header";
import { SessionStatusbar } from "../sessions/session-statusbar";
import { emptyFilters, startOfDayIso, endOfDayIso, historyStatusDotClass, type HistoryFilters } from "./history-helpers";
import { template, renderList, renderListLoading, renderProjectFilterOptions } from "./history-render";

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

async function selectHistorySession(sessionId: string, pane: HTMLElement): Promise<void> {
  // Mobile single-pane: reveals the chat pane, hides filter bar + list (mirrors
  // Sessions' data-mobile-pane toggle; CSS-gated to ≤768px, desktop unaffected).
  // Without this the filter bar, list, and chat content were all visible at
  // once on the phone.
  document.querySelector(".view-history")?.setAttribute("data-mobile-pane", "chat");
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
        showToast(`Couldn't continue this chat: ${err instanceof Error ? err.message : String(err)}`);
        return;
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

  // Mobile back button: return from the chat pane to the filterable list.
  // Only visible on ≤768px in chat mode (CSS-driven); a no-op on desktop.
  root.querySelector<HTMLButtonElement>("#historyBackBtn")?.addEventListener("click", () => {
    root.querySelector(".view-history")?.setAttribute("data-mobile-pane", "list");
  });

  void loadSessionCharacters();
  renderListLoading(listEl);
  await fetchEntries();
  if (state.mountId !== myMount) return () => { /* superseded */ };
  renderList(listEl, state.entries, state.filters, state.selectedId);
  if (projectSelect) renderProjectFilterOptions(projectSelect, state.projectOptions, state.filters.projectId);

  // If session-detail asked us to open a specific closed chat, select it now.
  // Otherwise auto-select the most recent session - except on the phone,
  // which should land on the filterable list first (matches Sessions'
  // isRemote() gate) rather than jumping straight into a chat.
  const pendingOrFirst = _pendingSelect ?? (isRemote() ? null : state.entries[0]?.session_id ?? null);
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
    renderList(listEl, state.entries, state.filters, state.selectedId);
    if (projectSelect) renderProjectFilterOptions(projectSelect, state.projectOptions, state.filters.projectId);
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
