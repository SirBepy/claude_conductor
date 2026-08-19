// "Your Todos" tab body (todo 692). The rail host owns the tab strip, width and
// close; this module owns only the board, the cards and the notify CTA.
// Scope is DERIVED from origin_session_id, never stored, so the same card sits
// in This chat here and Project wide in a sibling chat.

import { invoke } from "../../shared/ipc";
import { getTransport, type Unlisten } from "../../shared/transport";
import { escapeHtml } from "../../shared/escape-html";
import { agoText } from "./preview-panel-history";
import { openTodosColumnsMenu, closeTodosColumnsMenu } from "./todos-columns-menu";
import type { UserTodo } from "../../types/ipc.generated";
import "./todos-panel.css";

/** `here` is always on the board and never stored, hence absent here. */
export const OPTIONAL_COLUMNS = ["project", "done", "archived"] as const;

export interface TodosPanelHandle {
  setSessionScope(sessionId: string | null): void;
  refresh(): void;
  /** Opens the Columns menu against the strip's eye button. */
  toggleColumnsMenu(anchor: HTMLElement): void;
  destroy(): void;
}

interface TodosView {
  todos: UserTodo[];
  columns: string[];
}

const GROUP_LABEL: Record<string, string> = {
  here: "This chat",
  project: "Project wide",
  done: "Done",
  archived: "Archived",
};

const GROUP_EMPTY: Record<string, string> = {
  here: "Nothing is waiting on you in this chat.",
  project: "No other chat in this project needs anything from you.",
  done: "Nothing ticked yet.",
  archived: "Nothing retired yet.",
};

/** Escapes, then re-allows backtick `code` spans - the only markup a card carries. */
function renderText(text: string): string {
  return escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>');
}

function isOpen(t: UserTodo): boolean {
  return t.state === "open";
}

class TodosPanel implements TodosPanelHandle {
  private root: HTMLElement;
  private todos: UserTodo[] = [];
  private columns = new Set<string>();
  private sessionId: string | null = null;
  /** Keyed on the unseen ids, so `Later` silences only THAT set and a new
   *  change raises the bar again. */
  private dismissedKey = "";
  private unlisten: Unlisten | null = null;
  private focusHandler: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.classList.add("todos-panel");
    this.renderShell();
    this.wireEvents();
    void this.subscribeLive();
    this.focusHandler = () => this.refresh();
    window.addEventListener("focus", this.focusHandler);
  }

  setSessionScope(sessionId: string | null): void {
    if (this.sessionId === sessionId) return;
    closeTodosColumnsMenu();
    this.sessionId = sessionId;
    this.todos = [];
    this.columns.clear();
    this.dismissedKey = "";
    this.render();
    this.refresh();
  }

  refresh(): void {
    const sid = this.sessionId;
    if (!sid) return;
    void invoke<TodosView>("list_user_todos", { sessionId: sid })
      .then((view) => {
        // A scope change mid-flight must not paint the previous chat's cards.
        if (this.sessionId !== sid) return;
        this.todos = Array.isArray(view?.todos) ? view.todos : [];
        this.columns = new Set(Array.isArray(view?.columns) ? view.columns : []);
        this.render();
      })
      .catch((err) => console.error("[todos-panel] list_user_todos failed", err));
  }

  toggleColumnsMenu(anchor: HTMLElement): void {
    openTodosColumnsMenu(anchor, {
      counts: this.counts(),
      isShown: (key) => this.columns.has(key),
      onToggle: (key) => this.toggleColumn(key),
      onClearArchived: () => this.clearArchived(),
    });
  }

  destroy(): void {
    closeTodosColumnsMenu();
    if (this.unlisten) {
      try { this.unlisten(); } catch { /* ignore */ }
      this.unlisten = null;
    }
    if (this.focusHandler) {
      window.removeEventListener("focus", this.focusHandler);
      this.focusHandler = null;
    }
  }

  // ── Data ────────────────────────────────────────────────────────────────

  private async subscribeLive(): Promise<void> {
    try {
      this.unlisten = await getTransport().listen<{ project_id?: string }>(
        "user_todos_changed",
        () => this.refresh(),
      );
    } catch (err) {
      console.warn("[todos-panel] listen(user_todos_changed) failed", err);
    }
  }

  private inGroup(key: string): UserTodo[] {
    switch (key) {
      case "here": return this.todos.filter((t) => isOpen(t) && t.origin_session_id === this.sessionId);
      case "project": return this.todos.filter((t) => isOpen(t) && t.origin_session_id !== this.sessionId);
      case "done": return this.todos.filter((t) => t.state === "done");
      case "archived": return this.todos.filter((t) => t.state === "archived");
      default: return [];
    }
  }

  private counts(): Record<string, number> {
    return {
      here: this.inGroup("here").length,
      project: this.inGroup("project").length,
      done: this.inGroup("done").length,
      archived: this.inGroup("archived").length,
    };
  }

  private unseen(): UserTodo[] {
    return this.todos.filter((t) => !t.seen_by_origin);
  }

  private toggleColumn(key: string): void {
    if (this.columns.has(key)) this.columns.delete(key);
    else this.columns.add(key);
    this.render();
    const sid = this.sessionId;
    if (!sid) return;
    void invoke<void>("set_todo_columns", { sessionId: sid, columns: [...this.columns] })
      .catch((err) => console.error("[todos-panel] set_todo_columns failed", err));
  }

  private toggle(id: string): void {
    const sid = this.sessionId;
    const card = this.todos.find((t) => t.id === id);
    if (!sid || !card) return;
    // Ticking is silent by design: misclicks must be free. No wake, no
    // notification, only the CTA the daemon-side seen flag raises.
    const next = isOpen(card) ? "done" : "open";
    void invoke<void>("set_user_todo_state", { sessionId: sid, id, next })
      .then(() => this.refresh())
      .catch((err) => console.error("[todos-panel] set_user_todo_state failed", err));
  }

  private notifyPending(): void {
    const sid = this.sessionId;
    if (!sid) return;
    const origins = [...new Set(this.unseen().map((t) => t.origin_session_id))];
    void Promise.all(
      origins.map((origin) => invoke<void>("mark_todos_seen", { sessionId: sid, originSessionId: origin })),
    )
      .then(() => this.refresh())
      .catch((err) => console.error("[todos-panel] mark_todos_seen failed", err));
  }

  private clearArchived(): void {
    const sid = this.sessionId;
    if (!sid) return;
    void invoke<void>("clear_archived_todos", { sessionId: sid })
      .then(() => this.refresh())
      .catch((err) => console.error("[todos-panel] clear_archived_todos failed", err));
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  private renderShell(): void {
    this.root.innerHTML = `
      <div class="td-board" data-board></div>
      <div class="td-cta" data-cta hidden>
        <i class="ph ph-arrow-bend-up-right td-cta-lead"></i>
        <span class="td-cta-txt"></span>
        <span class="td-cta-who"></span>
        <span class="td-cta-grow"></span>
        <button type="button" class="td-cta-ghost" data-act="later">Later</button>
        <button type="button" class="td-cta-go" data-act="notify"><i class="ph ph-bell-ringing"></i>Notify</button>
      </div>
    `;
  }

  private cardHtml(t: UserTodo): string {
    const cls = [
      "td-card",
      t.state === "done" ? "is-done" : "",
      t.dropped ? "is-dropped" : "",
      t.seen_by_origin ? "" : "is-unsent",
    ].filter(Boolean).join(" ");

    const pills: string[] = [];
    if (t.dropped) pills.push(`<span class="td-pill td-pill-drop"><i class="ph ph-prohibit"></i>NOT NEEDED</span>`);
    if (t.by_ai && t.state === "done") pills.push(`<span class="td-pill td-pill-ai"><i class="ph ph-robot"></i>BY AI</span>`);

    const prev = t.previous_text
      ? `<div class="td-prev">${renderText(t.previous_text)}</div>`
      : "";
    const why = t.drop_reason ? `<span class="td-why">${escapeHtml(t.drop_reason)}</span>` : "";
    const dot = t.seen_by_origin ? "" : `<span class="td-unsent-dot"></span>`;

    return `<div class="${cls}" data-todo-id="${escapeHtml(t.id)}">
      ${dot}
      <div class="td-top">
        <button type="button" class="td-box" data-act="toggle" aria-label="Toggle done"><i class="ph-fill ph-check"></i></button>
        <div class="td-text">${renderText(t.text)}${prev}</div>
      </div>
      <div class="td-meta">${pills.join("")}${why}
        <span class="td-origin"><span class="td-origin-dot"></span>${escapeHtml(t.origin_label || "unknown")}</span>
        <span>${agoText(t.updated_at)}</span>
      </div>
    </div>`;
  }

  private columnHtml(key: string, secondary: boolean): string {
    const cards = this.inGroup(key);
    const body = cards.length
      ? cards.slice().reverse().map((t) => this.cardHtml(t)).join("")
      : `<div class="td-empty"><b>All clear</b>${GROUP_EMPTY[key] ?? ""}</div>`;
    const hide = secondary
      ? `<button type="button" class="td-col-hide" data-act="hide-col" data-col="${key}" title="Hide this column"><i class="ph ph-eye-slash"></i></button>`
      : "";
    return `<div class="td-col td-col-${key}${secondary ? " td-col-secondary" : ""}">
      <div class="td-col-head"><span class="td-swatch"></span>${GROUP_LABEL[key]}<span class="td-n">${cards.length}</span>${hide}</div>
      <div class="td-col-body">${body}</div>
    </div>`;
  }

  private render(): void {
    const board = this.root.querySelector<HTMLElement>("[data-board]");
    if (board) {
      const cols = ["here", ...OPTIONAL_COLUMNS.filter((c) => this.columns.has(c))];
      board.innerHTML = cols.map((c) => this.columnHtml(c, c !== "here")).join("");
    }
    this.renderCta();
  }

  private renderCta(): void {
    const bar = this.root.querySelector<HTMLElement>("[data-cta]");
    if (!bar) return;
    const unseen = this.unseen();
    const key = unseen.map((t) => t.id).sort().join(",");
    if (!unseen.length || key === this.dismissedKey) {
      bar.hidden = true;
      return;
    }
    const chats = [...new Set(unseen.map((t) => t.origin_label || "unknown"))];
    const n = unseen.length;
    const txt = bar.querySelector<HTMLElement>(".td-cta-txt");
    const who = bar.querySelector<HTMLElement>(".td-cta-who");
    if (txt) {
      txt.innerHTML = `<b>${n}</b> change${n === 1 ? "" : "s"} ${chats.length === 1 ? "it hasn't" : "they haven't"} seen`;
    }
    if (who) who.textContent = `· ${chats.join(", ")}`;
    bar.hidden = false;
  }

  private wireEvents(): void {
    this.root.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const act = target.closest<HTMLElement>("[data-act]");
      if (!act) return;
      switch (act.dataset.act) {
        case "toggle": {
          const id = act.closest<HTMLElement>("[data-todo-id]")?.dataset.todoId;
          if (id) this.toggle(id);
          return;
        }
        case "hide-col": {
          const col = act.dataset.col;
          if (col) this.toggleColumn(col);
          return;
        }
        case "later":
          this.dismissedKey = this.unseen().map((t) => t.id).sort().join(",");
          this.renderCta();
          return;
        case "notify":
          this.notifyPending();
          return;
        default:
      }
    });
  }
}

export function mountTodosPanel(root: HTMLElement): TodosPanelHandle {
  return new TodosPanel(root);
}
