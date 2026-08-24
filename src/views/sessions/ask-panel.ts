// The Ask panel: a read-only side conversation about the current chat, hosted
// in the FAB card. Mount signature matches mountTodosPanel so the card can hold
// either without knowing which.

import { invoke } from "../../shared/ipc";
import { escapeHtml } from "../../shared/escape-html";
import { splitSuggestion } from "./ask-suggestion";
import type { AskThread } from "../../types/ipc.generated";
import "./ask-panel.css";

export interface AskPanelDeps {
  /** Puts the drafted instruction in the real composer, unsent. */
  onDraft(text: string): void;
}

export interface AskPanelHandle {
  setSessionScope(sessionId: string | null): void;
  /** Project dir for the scoped chat; lets Ask read the repo, not just the chat. */
  setCwd(cwd: string | null): void;
  refresh(): void;
  destroy(): void;
}

class AskPanel implements AskPanelHandle {
  private root: HTMLElement;
  private deps: AskPanelDeps;
  private sessionId: string | null = null;
  private cwd: string | null = null;
  private threads: AskThread[] = [];
  private activeId: string | null = null;
  private indexOpen = false;
  private busy = false;
  /** Rendered as the user bubble while the sidecar runs - nothing is persisted
   *  until the answer returns, so without this the question vanishes. */
  private pendingQuestion: string | null = null;
  private error: string | null = null;
  private destroyed = false;

  constructor(root: HTMLElement, deps: AskPanelDeps) {
    this.root = root;
    this.deps = deps;
    this.root.classList.add("ask-panel");
    this.root.addEventListener("click", this.onClick);
    this.root.addEventListener("keydown", this.onKeydown);
    this.render();
  }

  setSessionScope(sessionId: string | null): void {
    if (sessionId === this.sessionId) return;
    this.sessionId = sessionId;
    this.threads = [];
    this.activeId = null;
    this.indexOpen = false;
    this.error = null;
    this.render();
    this.refresh();
  }

  setCwd(cwd: string | null): void {
    this.cwd = cwd;
  }

  refresh(): void {
    const sid = this.sessionId;
    if (!sid) return;
    void invoke<AskThread[]>("ask_list_threads", { sessionId: sid })
      .then((list) => {
        if (this.destroyed || this.sessionId !== sid) return;
        this.threads = list;
        if (!this.activeId && list.length) this.activeId = list[0]!.id;
        this.render();
      })
      .catch((err) => console.error("[ask-panel] ask_list_threads failed", err));
  }

  private active(): AskThread | null {
    return this.threads.find((t) => t.id === this.activeId) ?? null;
  }

  private send(question: string): void {
    const sid = this.sessionId;
    if (!sid || this.busy) return;
    const q = question.trim();
    if (!q) return;
    this.busy = true;
    this.error = null;
    this.pendingQuestion = q;
    this.render();
    void invoke<AskThread>("ask_send", {
      sessionId: sid,
      threadId: this.activeId,
      question: q,
      cwd: this.cwd,
    })
      .then((thread) => {
        if (this.destroyed || this.sessionId !== sid) return;
        const i = this.threads.findIndex((t) => t.id === thread.id);
        if (i >= 0) this.threads[i] = thread;
        else this.threads.unshift(thread);
        this.activeId = thread.id;
      })
      .catch((err) => {
        if (this.destroyed) return;
        this.error = String(err?.message ?? err);
      })
      .finally(() => {
        if (this.destroyed) return;
        this.busy = false;
        this.pendingQuestion = null;
        this.render();
      });
  }

  private newThread(): void {
    this.activeId = null;
    this.indexOpen = false;
    this.error = null;
    this.render();
    this.focusInput();
  }

  private deleteThread(id: string): void {
    const sid = this.sessionId;
    if (!sid) return;
    void invoke<AskThread[]>("ask_delete_thread", { sessionId: sid, threadId: id })
      .then((left) => {
        if (this.destroyed || this.sessionId !== sid) return;
        this.threads = left;
        if (this.activeId === id) this.activeId = left.length ? left[0]!.id : null;
        this.render();
      })
      .catch((err) => console.error("[ask-panel] ask_delete_thread failed", err));
  }

  private onClick = (ev: MouseEvent): void => {
    const el = ev.target as HTMLElement;
    const del = el.closest<HTMLElement>("[data-ask-del]");
    if (del) {
      ev.stopPropagation();
      this.deleteThread(del.dataset.askDel!);
      return;
    }
    if (el.closest("[data-ask-index-toggle]")) {
      this.indexOpen = !this.indexOpen;
      this.render();
      return;
    }
    if (el.closest("[data-ask-new]")) {
      this.newThread();
      return;
    }
    const pick = el.closest<HTMLElement>("[data-ask-pick]");
    if (pick) {
      this.activeId = pick.dataset.askPick!;
      this.indexOpen = false;
      this.render();
      return;
    }
    const draft = el.closest<HTMLElement>("[data-ask-draft]");
    if (draft) {
      this.deps.onDraft(draft.dataset.askDraft!);
      return;
    }
    if (el.closest("[data-ask-send]")) {
      this.sendFromInput();
    }
  };

  private onKeydown = (ev: KeyboardEvent): void => {
    if (ev.key !== "Enter" || ev.shiftKey) return;
    if (!(ev.target as HTMLElement).matches("[data-ask-input]")) return;
    ev.preventDefault();
    this.sendFromInput();
  };

  private sendFromInput(): void {
    const input = this.root.querySelector<HTMLInputElement>("[data-ask-input]");
    if (!input) return;
    const q = input.value;
    input.value = "";
    this.send(q);
  }

  private focusInput(): void {
    this.root.querySelector<HTMLInputElement>("[data-ask-input]")?.focus();
  }

  private render(): void {
    const t = this.active();
    const label = t?.title || "New thread";
    const count = this.threads.length;
    this.root.innerHTML =
      `<div class="ask-index">` +
        `<button type="button" class="ask-index-btn" data-ask-index-toggle>` +
          (count ? `<span class="ask-n">${count}</span>` : "") +
          `<span class="ask-ttl">${escapeHtml(label)}</span>` +
          `<i class="ph ph-caret-down"></i>` +
        `</button>` +
        (this.indexOpen ? this.indexMenuHtml() : "") +
      `</div>` +
      `<div class="ask-body">${this.bodyHtml(t)}</div>` +
      `<div class="ask-input">` +
        `<input type="text" data-ask-input placeholder="ask..."${this.busy ? " disabled" : ""}>` +
        `<button type="button" data-ask-send${this.busy ? " disabled" : ""}>Ask</button>` +
      `</div>`;
  }

  private indexMenuHtml(): string {
    const rows = this.threads
      .map(
        (t) =>
          `<div class="ask-menu-row${t.id === this.activeId ? " on" : ""}" data-ask-pick="${escapeHtml(t.id)}">` +
            `<span class="ask-ttl">${escapeHtml(t.title || "Untitled")}</span>` +
            `<button type="button" class="ask-del" title="Delete thread" data-ask-del="${escapeHtml(t.id)}">` +
              `<i class="ph ph-trash"></i></button>` +
          `</div>`,
      )
      .join("");
    return (
      `<div class="ask-menu">${rows}` +
      (rows ? `<div class="ask-menu-sep"></div>` : "") +
      `<button type="button" class="ask-menu-new" data-ask-new><i class="ph ph-plus"></i>New thread</button></div>`
    );
  }

  private bodyHtml(t: AskThread | null): string {
    const parts: string[] = [];
    for (const m of t?.messages ?? []) {
      if (m.role === "user") {
        parts.push(`<div class="ask-q">${escapeHtml(m.text)}</div>`);
        continue;
      }
      const { body, suggestion } = splitSuggestion(m.text);
      parts.push(`<div class="ask-a">${escapeHtml(body)}</div>`);
      if (suggestion) {
        parts.push(
          `<div class="ask-handoff">` +
            `<div class="ask-handoff-hl">hand off to the chat?</div>` +
            `<div class="ask-handoff-txt">${escapeHtml(suggestion)}</div>` +
            `<button type="button" data-ask-draft="${escapeHtml(suggestion)}">` +
              `<i class="ph ph-arrow-bend-left-down"></i>put in composer</button>` +
          `</div>`,
        );
      }
    }
    if (this.pendingQuestion) {
      parts.push(`<div class="ask-q">${escapeHtml(this.pendingQuestion)}</div>`);
    }
    if (this.busy) {
      parts.push(`<div class="ask-thinking"><span class="ask-spin"></span>reading...</div>`);
    }
    if (this.error) {
      parts.push(`<div class="ask-error">${escapeHtml(this.error)}</div>`);
    }
    if (!parts.length) {
      return (
        `<div class="ask-empty"><i class="ph ph-chat-teardrop-dots"></i>` +
        `<span>Ask about this chat, another chat, the repo, or the web.</span>` +
        `<span class="ask-ro">It can read. It can never edit or run anything.</span></div>`
      );
    }
    return parts.join("");
  }

  destroy(): void {
    this.destroyed = true;
    this.root.removeEventListener("click", this.onClick);
    this.root.removeEventListener("keydown", this.onKeydown);
    this.root.classList.remove("ask-panel");
    this.root.innerHTML = "";
  }
}

export function mountAskPanel(root: HTMLElement, deps: AskPanelDeps): AskPanelHandle {
  return new AskPanel(root, deps);
}
