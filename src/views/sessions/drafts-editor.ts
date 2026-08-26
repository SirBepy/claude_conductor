// One draft card's editor (todo 666): a contenteditable that shows bold as
// bold, a format toolbar, recipient/version pickers and the dual-payload Copy.
// The panel owns the list and hands this one draft plus a save callback.

import { invoke } from "../../shared/ipc";
import { escapeHtml } from "../../shared/escape-html";
import { renderMarkdown } from "../../shared/chat/chat-transforms";
import { htmlToMarkdown } from "../../shared/chat/draft-markdown";
import type { MessageDraft, DraftVariant } from "../../types/ipc.generated";

/** Long enough that a normal sentence pause does not round-trip to the daemon;
 *  the store coalesces anyway, so this only trades chattiness for latency. */
const AUTOSAVE_MS = 1800;

export interface DraftsEditorDeps {
  sessionId: string;
  onBack(): void;
  onChanged(): void;
}

/** execCommand is deprecated but is the only editing API WebView2 implements
 *  end to end; the alternative is hand-rolling selection surgery. */
const MARKS = [
  { cmd: "bold", icon: "ph-text-b", title: "Bold" },
  { cmd: "italic", icon: "ph-text-italic", title: "Italic" },
  { cmd: "strikeThrough", icon: "ph-text-strikethrough", title: "Strikethrough" },
  { cmd: "insertUnorderedList", icon: "ph-list-bullets", title: "Bullets" },
  { cmd: "insertOrderedList", icon: "ph-list-numbers", title: "Numbered" },
] as const;

export function currentVersion(variant: DraftVariant) {
  return variant.versions.find((v) => v.n === variant.current) ?? variant.versions[variant.versions.length - 1];
}

export function handleOf(variant: DraftVariant): string {
  return `${variant.recipient} #${variant.handle_n}`;
}

export class DraftsEditor {
  private root: HTMLElement;
  private deps: DraftsEditorDeps;
  private draft: MessageDraft;
  private recipient: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** What the body held at the last successful save, so a save that changes
   *  nothing never appends a version. */
  private saved = "";

  constructor(root: HTMLElement, draft: MessageDraft, deps: DraftsEditorDeps) {
    this.root = root;
    this.deps = deps;
    this.draft = draft;
    this.recipient = draft.variants[0]?.recipient ?? "";
    this.render();
    this.root.addEventListener("click", this.onClick);
    this.root.addEventListener("input", this.onInput);
    this.root.addEventListener("change", this.onChange);
  }

  /** A live refresh must not yank the caret or clobber what is being typed, so
   *  only the chrome is repainted while the body has focus. */
  update(draft: MessageDraft): void {
    this.draft = draft;
    const body = this.bodyEl();
    if (body && document.activeElement === body) {
      this.renderChrome();
      return;
    }
    this.render();
  }

  destroy(): void {
    this.flush();
    this.root.removeEventListener("click", this.onClick);
    this.root.removeEventListener("input", this.onInput);
    this.root.removeEventListener("change", this.onChange);
  }

  /** Writes any pending edit now. Called on teardown and before navigating
   *  away, so closing the card never loses the last keystrokes. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const body = this.bodyEl();
    if (!body) return;
    const markdown = htmlToMarkdown(body);
    if (markdown === this.saved) return;
    this.saved = markdown;
    void invoke("set_draft_body", {
      sessionId: this.deps.sessionId,
      id: this.draft.id,
      recipient: this.recipient,
      body: markdown,
    })
      .then(() => this.deps.onChanged())
      .catch((err) => console.error("[drafts-editor] set_draft_body failed", err));
  }

  // ── Render ──────────────────────────────────────────────────────────────

  private variant(): DraftVariant | undefined {
    return this.draft.variants.find((v) => v.recipient === this.recipient) ?? this.draft.variants[0];
  }

  private bodyEl(): HTMLElement | null {
    return this.root.querySelector<HTMLElement>(".dr-body");
  }

  private render(): void {
    const variant = this.variant();
    const version = variant ? currentVersion(variant) : undefined;
    const markdown = version?.body ?? "";
    this.saved = markdown;
    this.root.innerHTML =
      this.chromeHtml() +
      `<div class="dr-bar">` +
        MARKS.map(
          (m) => `<button type="button" class="dr-fbtn" data-cmd="${m.cmd}" title="${m.title}">` +
            `<i class="ph ${m.icon}"></i></button>`,
        ).join("") +
        `<span class="dr-fsep"></span>` +
        `<button type="button" class="dr-fbtn" data-code title="Code"><i class="ph ph-code"></i></button>` +
        `<button type="button" class="dr-fbtn" data-cmd="formatBlock" data-arg="blockquote" title="Quote">` +
          `<i class="ph ph-quotes"></i></button>` +
      `</div>` +
      `<div class="dr-body" contenteditable="true" spellcheck="true">${renderMarkdown(markdown)}</div>` +
      this.footHtml();
  }

  /** Repaints everything except the contenteditable, so a live update can land
   *  while the caret is in the body. */
  private renderChrome(): void {
    const head = this.root.querySelector(".dr-top");
    const foot = this.root.querySelector(".dr-foot");
    if (head) head.outerHTML = this.chromeHtml();
    if (foot) foot.outerHTML = this.footHtml();
  }

  private chromeHtml(): string {
    const variant = this.variant();
    const version = variant ? currentVersion(variant) : undefined;
    const stamp = version?.author === "user" ? "edited by you" : "by Claude";
    const recipients = this.draft.variants
      .map(
        (v) => `<option value="${escapeHtml(v.recipient)}"${v.recipient === this.recipient ? " selected" : ""}>` +
          `${escapeHtml(handleOf(v))}</option>`,
      )
      .join("");
    const versions = (variant?.versions ?? [])
      .slice()
      .reverse()
      .map((v) => {
        const who = v.author === "user" ? "you" : "Claude";
        const label = v.note ? `v${v.n} - ${v.note}` : `v${v.n} - ${who}`;
        return `<option value="${v.n}"${v.n === variant?.current ? " selected" : ""}>${escapeHtml(label)}</option>`;
      })
      .join("");
    return (
      `<div class="dr-top">` +
        `<div class="dr-head">` +
          `<button type="button" class="dr-icon" data-back title="Back to drafts"><i class="ph ph-arrow-left"></i></button>` +
          `<span class="dr-title">${escapeHtml(this.draft.topic)}</span>` +
          `<button type="button" class="dr-icon" data-delete title="Delete draft"><i class="ph ph-trash"></i></button>` +
        `</div>` +
        `<div class="dr-meta">` +
          `<select class="dr-drop" data-recipient aria-label="Recipient">${recipients}</select>` +
          `<select class="dr-drop" data-version aria-label="Version">${versions}</select>` +
          `<span class="dr-stamp">${stamp}</span>` +
        `</div>` +
      `</div>`
    );
  }

  private footHtml(): string {
    const ready = this.draft.state === "ready";
    return (
      `<div class="dr-foot">` +
        `<button type="button" class="dr-btn dr-primary" data-copy><i class="ph ph-copy"></i> Copy</button>` +
        `<span class="dr-grow"></span>` +
        `<button type="button" class="dr-btn${ready ? " on" : ""}" data-ready>` +
          `<i class="ph ${ready ? "ph-check-circle" : "ph-circle"}"></i> Ready</button>` +
      `</div>`
    );
  }

  // ── Events ──────────────────────────────────────────────────────────────

  private onInput = (): void => {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), AUTOSAVE_MS);
  };

  private onChange = (ev: Event): void => {
    const el = ev.target as HTMLElement;
    if (el.matches("[data-recipient]")) {
      this.flush();
      this.recipient = (el as HTMLSelectElement).value;
      this.render();
      return;
    }
    if (el.matches("[data-version]")) {
      this.flush();
      const n = Number((el as HTMLSelectElement).value);
      void invoke("set_draft_version", {
        sessionId: this.deps.sessionId,
        id: this.draft.id,
        recipient: this.recipient,
        n,
      })
        .then(() => this.deps.onChanged())
        .catch((err) => console.error("[drafts-editor] set_draft_version failed", err));
    }
  };

  private onClick = (ev: MouseEvent): void => {
    const el = ev.target as HTMLElement;
    if (el.closest("[data-back]")) {
      this.flush();
      this.deps.onBack();
      return;
    }
    if (el.closest("[data-delete]")) {
      this.remove();
      return;
    }
    if (el.closest("[data-copy]")) {
      this.copy(el.closest("[data-copy]") as HTMLElement);
      return;
    }
    if (el.closest("[data-ready]")) {
      this.setState(this.draft.state === "ready" ? "needs-you" : "ready");
      return;
    }
    const code = el.closest("[data-code]");
    if (code) {
      ev.preventDefault();
      this.wrapCode();
      return;
    }
    const mark = el.closest<HTMLElement>("[data-cmd]");
    if (mark) {
      ev.preventDefault();
      this.bodyEl()?.focus();
      document.execCommand(mark.dataset.cmd!, false, mark.dataset.arg);
    }
  };

  // ── Actions ─────────────────────────────────────────────────────────────

  /** No execCommand for inline code, so the selection is wrapped by hand. */
  private wrapCode(): void {
    const body = this.bodyEl();
    const sel = window.getSelection();
    if (!body || !sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (!body.contains(range.commonAncestorContainer)) return;
    const code = document.createElement("code");
    code.textContent = range.toString();
    range.deleteContents();
    range.insertNode(code);
    sel.removeAllRanges();
    this.onInput();
  }

  /** Both payloads in one write: Slack and Google Chat read the tags, a plain
   *  field gets the markdown rather than stripped mush. */
  private copy(btn: HTMLElement): void {
    const body = this.bodyEl();
    if (!body) return;
    this.flush();
    const html = body.innerHTML;
    const plain = htmlToMarkdown(body);
    const done = () => {
      const icon = btn.querySelector("i");
      if (icon) icon.className = "ph ph-check";
      setTimeout(() => {
        const back = btn.querySelector("i");
        if (back) back.className = "ph ph-copy";
      }, 1500);
      this.setState("copied");
    };
    void navigator.clipboard
      .write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plain], { type: "text/plain" }),
        }),
      ])
      .then(done)
      .catch(() => void navigator.clipboard.writeText(plain).then(done));
  }

  private setState(next: string): void {
    void invoke("set_draft_state", { sessionId: this.deps.sessionId, id: this.draft.id, next })
      .then(() => this.deps.onChanged())
      .catch((err) => console.error("[drafts-editor] set_draft_state failed", err));
  }

  private remove(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    void invoke("delete_draft", { sessionId: this.deps.sessionId, id: this.draft.id })
      .then(() => {
        this.deps.onChanged();
        this.deps.onBack();
      })
      .catch((err) => console.error("[drafts-editor] delete_draft failed", err));
  }
}
