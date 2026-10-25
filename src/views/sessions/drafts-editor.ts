// One draft card's editor: the topic as its title, a version picker beside
// Copy and Archive, a contenteditable that shows bold as bold (its format
// toolbar only while typing), and a footer box for asking Claude to change it.
// The panel owns the list and hands this one draft plus a save callback.

import { invoke } from "../../shared/ipc";
import { showToast } from "../../shared/toast";
import { escapeHtml } from "../../shared/escape-html";
import { renderMarkdown } from "../../shared/chat/chat-transforms";
import { composerFieldHtml, wireComposerField, type ComposerFieldWiring } from "../../shared/chat/composer-field";
import { htmlToMarkdown } from "../../shared/chat/draft-markdown";
import { currentVersion, copyDualPayload, handleOf } from "../../shared/message-draft-utils";
import type { MessageDraft, DraftVariant } from "../../types/ipc.generated";
import { ReviseMenuController, buildLearnPrompt, sendRevision } from "./drafts-revise";

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

export class DraftsEditor {
  private root: HTMLElement;
  private deps: DraftsEditorDeps;
  private draft: MessageDraft;
  private recipient: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** What the body held at the last successful save, so a save that changes
   *  nothing never appends a version. */
  private saved = "";
  /** Consecutive failed autosaves. One toast at the 3rd, not one per retry
   *  (the timer keeps retrying every AUTOSAVE_MS while the user keeps typing). */
  private autosaveFailures = 0;
  private reviseMenu: ReviseMenuController;
  /** The footer's free-text box; rewired on every full render(). */
  private reviseField: ComposerFieldWiring | null = null;
  /** The version list under the version chip. */
  private versionsOpen = false;
  /** The version Check & learn was last sent for, so a repaint keeps saying so. */
  private learnSentFor: number | null = null;

  constructor(root: HTMLElement, draft: MessageDraft, deps: DraftsEditorDeps) {
    this.root = root;
    this.deps = deps;
    this.draft = draft;
    this.recipient = draft.variants[0]?.recipient ?? "";
    this.reviseMenu = new ReviseMenuController({
      root: this.root,
      bodyEl: () => this.bodyEl(),
      draft: () => this.draft,
      variant: () => this.variant(),
      sessionId: this.deps.sessionId,
      flush: () => this.flush(),
    });
    this.render();
    this.root.addEventListener("click", this.onClick);
    this.root.addEventListener("input", this.onInput);
    this.root.addEventListener("pointerdown", this.onPointerDown);
    this.root.addEventListener("keydown", this.onKeydown);
  }

  /** A live refresh must not yank the caret or clobber what is being typed, so
   *  only the chrome is repainted while the body has focus. */
  update(draft: MessageDraft): void {
    this.draft = draft;
    const body = this.bodyEl();
    const active = document.activeElement;
    const typing = active === body || !!active?.closest(".dr-rv-menu, .dr-foot");
    if (body && typing) {
      this.renderChrome();
      return;
    }
    this.render();
  }

  destroy(): void {
    this.flush();
    this.root.removeEventListener("click", this.onClick);
    this.root.removeEventListener("input", this.onInput);
    this.root.removeEventListener("pointerdown", this.onPointerDown);
    this.root.removeEventListener("keydown", this.onKeydown);
    document.removeEventListener("pointerdown", this.onOutsideVersions, true);
    this.reviseMenu.destroy();
    this.reviseField?.destroy();
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
    // `saved` only advances once the write actually lands - if it rejects,
    // the next flush (autosave timer, back, or destroy) still sees a diff
    // against the old `saved` and retries the same markdown, instead of
    // treating an unwritten edit as already persisted.
    void invoke("set_draft_body", {
      sessionId: this.deps.sessionId,
      id: this.draft.id,
      recipient: this.recipient,
      body: markdown,
    })
      .then(() => {
        this.saved = markdown;
        this.autosaveFailures = 0;
        this.deps.onChanged();
      })
      .catch((err) => {
        console.error("[drafts-editor] set_draft_body failed", err);
        this.autosaveFailures++;
        if (this.autosaveFailures === 3) showToast("Draft isn't saving - check your connection.");
      });
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
    // The format row sits under the body, so sliding it in while typing grows
    // the bottom edge instead of pushing the text down.
    this.root.innerHTML =
      this.chromeHtml() +
      `<div class="dr-body" contenteditable="true" spellcheck="true">${renderMarkdown(markdown)}</div>` +
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
      this.footHtml() +
      `<div class="dr-rv-host">${this.reviseMenu.menuHtml()}</div>`;
    this.reviseField?.destroy();
    this.reviseField = wireComposerField(this.root.querySelector<HTMLElement>(".dr-foot")!, {
      onSend: (text) => {
        this.reviseField?.clear();
        this.reviseMenu.sendFree(text);
      },
    });
  }

  /** Repaints the header only, so a live update can land while the caret is
   *  in the body or the footer box. */
  private renderChrome(): void {
    const head = this.root.querySelector(".dr-top");
    if (head) head.outerHTML = this.chromeHtml();
  }

  private chromeHtml(): string {
    const variant = this.variant();
    const version = variant ? currentVersion(variant) : undefined;
    const archived = this.draft.state === "archived";
    // Names only, and only when there is a choice to make.
    const who = this.draft.variants.length > 1
      ? `<div class="dr-who">` + this.draft.variants.map((v) =>
          `<button type="button" class="dr-who-tab${v.recipient === this.recipient ? " on" : ""}" ` +
            `data-recipient="${escapeHtml(v.recipient)}">${escapeHtml(v.recipient)}</button>`).join("") +
        `</div>`
      : "";
    return (
      `<div class="dr-top">` +
        `<div class="dr-head">` +
          `<button type="button" class="icon-btn-sq dr-icon" data-back title="Back to drafts"><i class="ph ph-arrow-left"></i></button>` +
          `<span class="dr-title">${escapeHtml(this.draft.topic)}</span>` +
        `</div>` +
        who +
        `<div class="dr-meta">` +
          this.versionPickerHtml(variant, version?.n) +
          // Only once the shown text is the user's own: there is nothing to
          // check or learn from in Claude's untouched version.
          (version?.author !== "user" ? ""
            : this.learnSentFor === version.n
              ? `<button type="button" class="dr-learn" disabled><i class="ph ph-check"></i>Sent to Claude</button>`
              : `<button type="button" class="dr-learn" data-learn ` +
                  `title="Ask Claude to fact-check your edit and learn how you like messages written">` +
                  `<i class="ph ph-graduation-cap"></i>Check &amp; learn</button>`) +
          `<span class="dr-grow"></span>` +
          `<button type="button" class="icon-btn-sq dr-icon dr-copy" data-copy title="Copy - marks it sent"><i class="ph ph-copy"></i></button>` +
          (archived
            ? `<button type="button" class="icon-btn-sq dr-icon" data-archive title="Unarchive"><i class="ph ph-box-arrow-up"></i></button>`
            : `<button type="button" class="icon-btn-sq dr-icon" data-archive title="Archive - put away without sending"><i class="ph ph-archive"></i></button>`) +
        `</div>` +
      `</div>`
    );
  }

  /** One chip for the shown version; the full list, newest first, opens under
   *  it. A chip per version stopped fitting the row past a handful. */
  private versionPickerHtml(variant: DraftVariant | undefined, current: number | undefined): string {
    const versions = variant?.versions ?? [];
    const pen = (author: string) => (author === "user" ? `<i class="ph ph-pencil-simple" aria-label="your edit"></i>` : "");
    const shown = versions.find((v) => v.n === current);
    if (versions.length < 2) return `<span class="dr-ver-only">v${current ?? 1}${shown ? pen(shown.author) : ""}</span>`;
    const list = this.versionsOpen
      ? `<div class="dr-ver-list" role="menu">` + versions.slice().reverse().map((v) =>
          `<button type="button" class="dr-ver-row${v.n === current ? " on" : ""}" data-version-n="${v.n}" role="menuitem">` +
            `<span class="dr-ver-n">v${v.n}</span>` +
            `<span class="dr-ver-note">${escapeHtml(v.author === "user" ? "Your edit" : v.note || "Claude")}</span>` +
            pen(v.author) +
          `</button>`).join("") + `</div>`
      : "";
    return (
      `<button type="button" class="dr-ver-btn${this.versionsOpen ? " open" : ""}" data-versions aria-haspopup="menu" ` +
        `aria-expanded="${this.versionsOpen}" title="Versions">` +
        `v${current ?? 1}${shown ? pen(shown.author) : ""}<i class="ph ph-caret-down dr-caret"></i>` +
      `</button>` + list
    );
  }

  /** Free text goes straight to Claude; the caret beside send opens the
   *  presets, the way the chat composer's chevron sits beside its send. */
  private footHtml(): string {
    return composerFieldHtml({
      rowClass: "dr-foot",
      inputAttrs: `data-revise-free aria-label="Ask Claude to change this draft"`,
      placeholder: "Ask Claude to change this...",
      after:
        `<button type="button" class="icon-btn dr-presets${this.reviseMenu.isOpen ? " open" : ""}" data-revise aria-haspopup="menu" ` +
          `title="Quick changes - the highlighted part, or the whole draft"><i class="ph ph-caret-up"></i></button>`,
    });
  }

  private setVersionsOpen(open: boolean): void {
    this.versionsOpen = open;
    this.renderChrome();
    if (open) document.addEventListener("pointerdown", this.onOutsideVersions, true);
    else document.removeEventListener("pointerdown", this.onOutsideVersions, true);
  }

  private onOutsideVersions = (ev: PointerEvent): void => {
    const el = ev.target as HTMLElement;
    if (el.closest(".dr-ver-list") || el.closest("[data-versions]")) return;
    this.setVersionsOpen(false);
  };

  // ── Events ──────────────────────────────────────────────────────────────

  private onInput = (): void => {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), AUTOSAVE_MS);
  };

  private pickVersion(n: number): void {
    this.flush();
    this.setVersionsOpen(false);
    void invoke("set_draft_version", {
      sessionId: this.deps.sessionId,
      id: this.draft.id,
      recipient: this.recipient,
      n,
    })
      .then(() => this.deps.onChanged())
      .catch((err) => console.error("[drafts-editor] set_draft_version failed", err));
  }

  private onClick = (ev: MouseEvent): void => {
    const el = ev.target as HTMLElement;
    if (el.closest("[data-back]")) {
      this.flush();
      this.deps.onBack();
      return;
    }
    const who = el.closest<HTMLElement>("[data-recipient]");
    if (who) {
      this.flush();
      this.recipient = who.dataset.recipient ?? this.recipient;
      this.versionsOpen = false;
      this.render();
      return;
    }
    if (el.closest("[data-learn]")) {
      this.checkAndLearn();
      return;
    }
    if (el.closest("[data-versions]")) {
      this.setVersionsOpen(!this.versionsOpen);
      return;
    }
    const pick = el.closest<HTMLElement>("[data-version-n]");
    if (pick) {
      this.pickVersion(Number(pick.dataset.versionN));
      return;
    }
    if (el.closest("[data-archive]")) {
      this.flush();
      if (this.draft.state === "archived") {
        this.setState("needs-you");
        return;
      }
      // Archiving is "done with this one", so it also leaves the card.
      this.setState("archived");
      this.deps.onBack();
      return;
    }
    if (el.closest("[data-copy]")) {
      this.copy(el.closest("[data-copy]") as HTMLElement);
      return;
    }
    if (this.reviseMenu.handleClick(el)) return;
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

  /** Forwards to the Revise menu controller: it alone decides whether this
   *  click is its own (the body's selection capture, right before a focused
   *  button would collapse it). */
  private onPointerDown = (ev: PointerEvent): void => {
    // The format buttons only show while the body has focus, so pressing one
    // must not take that focus away before its click lands.
    if ((ev.target as HTMLElement).closest(".dr-bar")) ev.preventDefault();
    this.reviseMenu.capturePointerDown(ev);
  };

  private onKeydown = (ev: KeyboardEvent): void => {
    this.reviseMenu.handleKeydown(ev);
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

  /** Sends the edit to the chat that wrote the draft, with Claude's own last
   *  version beside it, so it can fact-check the edit and learn from the
   *  difference. Flushes first so the newest keystrokes are what it sees. */
  private checkAndLearn(): void {
    const variant = this.variant();
    const body = this.bodyEl();
    if (!variant || !body) return;
    this.flush();
    const mine = currentVersion(variant);
    const claudes = variant.versions.filter((v) => v.author === "ai" && v.n < (mine?.n ?? 0)).pop();
    const text = buildLearnPrompt({
      topic: this.draft.topic,
      handle: handleOf(variant),
      recipient: variant.person ?? variant.recipient,
      mine: { n: mine?.n ?? 1, body: htmlToMarkdown(body) },
      claudes: claudes ? { n: claudes.n, body: claudes.body } : null,
    });
    void sendRevision(this.draft.origin_session_id, this.deps.sessionId, text).then((sent) => {
      if (!sent) return;
      this.learnSentFor = mine?.n ?? null;
      this.renderChrome();
    });
  }

  private copy(btn: HTMLElement): void {
    const body = this.bodyEl();
    if (!body) return;
    this.flush();
    const html = body.innerHTML;
    const plain = htmlToMarkdown(body);
    copyDualPayload(html, plain, btn, () => this.setState("copied"));
  }

  private setState(next: string): void {
    void invoke("set_draft_state", { sessionId: this.deps.sessionId, id: this.draft.id, next })
      .then(() => this.deps.onChanged())
      .catch((err) => console.error("[drafts-editor] set_draft_state failed", err));
  }
}
