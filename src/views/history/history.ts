import { render } from "lit-html";
import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { showView } from "../../shared/navigation";
import { ChatRenderer } from "../../shared/chat/chat-renderer";
import { sessionEvents } from "../../shared/chat/event-store";
import { mountChatLoadingOverlay } from "../../shared/chat/chat-loading";
import { setCodeModeChatProvider } from "../sessions/code-mode/entry";
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
import "../sessions/session-statusbar-images.css";
import "../sessions/overflow-panel.css";
import "./history.css";
import type { HistoryEntry } from "../../types/ipc.generated";
import { cwdToProjectName } from "../sessions/sessions-helpers";
import { hydrateCharacterAvatars } from "../../shared/projects";
import { characterForSessionId, characterIconUrl, loadSessionCharacters } from "../sessions/session-characters";
import { SessionHeader } from "../sessions/session-header";
import { SessionStatusbar } from "../sessions/session-statusbar";
import { historyStatusDotClass } from "./history-helpers";
import { template, renderList, renderListLoading } from "./history-render";

interface HistoryState {
  mountId: number;
  entries: HistoryEntry[];
  selectedId: string | null;
  renderer: ChatRenderer | null;
  statusbar: SessionStatusbar | null;
}

let state: HistoryState = {
  mountId: 0,
  entries: [],
  selectedId: null,
  renderer: null,
  statusbar: null,
};
let nextMountId = 1;
let _pendingSelect: { sessionId: string; projectId: string | null } | null = null;

/**
 * Open a specific past session read-only on the next History-view mount. Used
 * by the chats-window cross-window open request and the project dashboard's
 * closed-chat rows. `projectId` is the Claude project-dir slug
 * (`HistoryEntry.project_id`); neither caller has it, so the mount learns it
 * from the opened entry when omitted.
 */
export function queueHistorySelect(sessionId: string, projectId: string | null = null): void {
  _pendingSelect = { sessionId, projectId };
}

async function listHistory(projectId: string | null): Promise<HistoryEntry[] | null> {
  try {
    return (await invoke<HistoryEntry[]>("list_history", {
      projectId,
      search: null,
      limit: 200,
      offset: 0,
      modelFilter: null,
      dateFrom: null,
      dateTo: null,
    })) || [];
  } catch (err) {
    console.error("[history] list_history failed", err);
    return null;
  }
}

/**
 * The left list follows the opened chat's project, not every project's newest
 * 200. A caller that only knows the session id gets one unscoped read to find
 * the entry, then one scoped read; if the entry is not among the newest 200 the
 * unscoped list stays rather than showing nothing.
 */
async function fetchEntries(pending: { sessionId: string; projectId: string | null } | null): Promise<void> {
  const scopeId = pending?.projectId ?? null;
  const first = await listHistory(scopeId);
  state.entries = first ?? [];
  if (!pending || scopeId || !first) return;
  const projectId = first.find((e) => e.session_id === pending.sessionId)?.project_id;
  if (!projectId || first.every((e) => e.project_id === projectId)) return;
  const scoped = await listHistory(projectId);
  if (scoped) state.entries = scoped;
}

async function selectHistorySession(sessionId: string, pane: HTMLElement): Promise<void> {
  // Mobile single-pane: reveals the chat pane, hides the list (mirrors
  // Sessions' data-mobile-pane toggle; CSS-gated to ≤768px, desktop unaffected).
  // Without this the list and chat content were both visible at once on the phone.
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
      const accountId = await openChangeAccountModal({
        currentId: null,
        title: "Continue as which account?",
        autoPickSole: true,
      });
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
  // Code mode from a past chat: its repo and its edits, nothing live.
  const layout = pane.closest<HTMLElement>(".history-layout");
  const histCwd = entry?.cwd ? String(entry.cwd) : null;
  setCodeModeChatProvider(histCwd && layout
    ? () => ({
        key: `history:${sessionId}`,
        sessionId: null,
        cwd: histCwd,
        layout,
        title: () => entry?.title ?? "",
        busy: () => false,
        latestLine: () => "",
        edits: () => renderer.getFileEdits(),
        mention: null,
      })
    : null);

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
  const overlay = sessionEvents.isLoaded(sessionId) ? null : mountChatLoadingOverlay(messagesEl);
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
    selectedId: null,
    renderer: null,
    statusbar: null,
  };

  render(template(), root);

  const listEl = root.querySelector<HTMLElement>("#history-list");
  const pane = root.querySelector<HTMLElement>(".history-pane");

  if (!listEl || !pane) {
    console.error("[history] view template missing expected nodes");
    return () => { /* no-op */ };
  }

  // Mobile back button: return from the chat pane to the list.
  // Only visible on ≤768px in chat mode (CSS-driven); a no-op on desktop.
  root.querySelector<HTMLButtonElement>("#historyBackBtn")?.addEventListener("click", () => {
    root.querySelector(".view-history")?.setAttribute("data-mobile-pane", "list");
  });

  void loadSessionCharacters();
  renderListLoading(listEl);
  // Cleared only after the superseded check: a mount that loses the race must
  // leave the queue for the mount that replaced it.
  const pending = _pendingSelect;
  await fetchEntries(pending);
  if (state.mountId !== myMount) return () => { /* superseded */ };
  _pendingSelect = null;
  renderList(listEl, state.entries, state.selectedId);

  // If a caller queued a specific closed chat (queueHistorySelect), select it now.
  // Otherwise auto-select the most recent session - except on the phone,
  // which should land on the list first (matches Sessions'
  // isRemote() gate) rather than jumping straight into a chat.
  const pendingOrFirst = pending?.sessionId ?? (isRemote() ? null : state.entries[0]?.session_id ?? null);
  if (pendingOrFirst) {
    const li = listEl.querySelector<HTMLLIElement>(`li[data-session-id="${CSS.escape(pendingOrFirst)}"]`);
    if (li) {
      listEl.querySelectorAll("li[data-session-id]").forEach((el) => el.classList.remove("active"));
      li.classList.add("active");
      li.scrollIntoView({ block: "center" });
    }
    void selectHistorySession(pendingOrFirst, pane);
  }

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
    if (state.renderer) {
      state.renderer.detach();
      state.renderer = null;
    }
    state.statusbar?.destroy();
    state.statusbar = null;
    state.selectedId = null;
  };
}
