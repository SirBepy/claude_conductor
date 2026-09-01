// Composer: textarea + send button + image paste support. Phase 5b ships
// without IPC wiring (the paste handler best-effort calls `paste_image` if
// it exists, falls back to attaching base64 only). Phase 6 wires the IPC
// command and converts attachments to <file:path> mention text on send.

import type { ContentBlock, Recurrence } from "../../types/ipc.generated";
import { openSchedulePicker } from "./schedule-picker";
import { openComposerMenu, type ComposerMenuItem } from "./composer-menu";
import { SlashProvider } from "./caret-popup/providers/slash";
import { FileProvider } from "./caret-popup/providers/file";
import type { SuggestProvider } from "./caret-popup/types";
import type { ChatRenderer } from "./chat-renderer";
import { parseBuiltin, HANDLERS, type BuiltinContext } from "./builtins";
import { highlightComposerInput } from "./chat-transforms";
import { blocksToText } from "./content-blocks";
import { ComposerCore } from "./composer-core/core";
import { ComposerVoice } from "./voice/composer-voice";
import { ComposerPtt } from "./voice/composer-ptt";
import "./composer-core/core.css";
import "./voice/voice.css";
import "./builtins/register";
import "./caret-popup/popup.css";
import { ComposerAttachments, type Attachment, type PastedBlock } from "./composer-attachments";
import { loadDraft, saveDraft, clearDraft } from "./composer-persistence";
import { recordSent, popLastSent, moveSentOutbox } from "./sent-outbox";
import { ComposerDraftSync } from "./composer-draft-sync";
import { openFrozenChoice } from "./composer-frozen-choice";
import { isMobileViewport } from "../mobile-viewport";
import { HOST_ID as QUESTION_CARD_HOST_ID } from "../../views/sessions/permission-modal/host";
import * as shortcuts from "../shortcuts";
export { discardComposerDraft, moveComposerDraft } from "./composer-persistence";

export interface ComposerOptions {
  onSend: (blocks: ContentBlock[]) => Promise<void> | void;
  projectDir?: string | null;
  getRenderer?: () => ChatRenderer | null;
  /** True while the active session's turn is in flight. When busy, Enter stages
   * the message (via onStage) instead of sending it. */
  isBusy?: () => boolean;
  /** Non-null while the active session's account is out of usage (a rate-limit
   * rejection blocked it). The composer stays enabled: a send schedules the
   * draft for `resetsAtIso` (the daemon's own reset+60s delay) instead of
   * sending immediately. `placeholder`, if given, replaces the textarea's
   * idle placeholder text (e.g. naming the account and raw reset time). */
  isBlocked?: () => { resetsAtIso: string; resetsAtLabel: string; placeholder?: string } | null;
  /** True while the active session is frozen (`Instance.frozen`). A send
   * opens a hold-vs-send-now popover instead of sending directly. */
  isFrozen?: () => boolean;
  /** Stage the built blocks as a held message (while busy, or frozen-hold). */
  onStage?: (blocks: ContentBlock[]) => boolean | void;
  /** True when a held set exists for the active session. When not busy but
   * held items exist, a normal send bundles them via flushHeldWithDraft. */
  hasHeld?: () => boolean;
  /** Ctrl+Z pop-back: pull the last-staged held message off the queue. */
  popLastHeld?: () => ContentBlock[] | null;
  /** Flush the held set together with the current draft as one message. The
   * composer clears itself after calling, and restores the draft on false. */
  flushHeldWithDraft?: (draftBlocks: ContentBlock[]) => Promise<boolean | void> | boolean | void;
  /** Interrupt + flush the held set now (same as the chip's "Send now").
   * Ctrl+Enter on an empty draft routes here instead of a normal send. */
  sendQueuedNow?: () => Promise<void> | void;
  /** Fired on draft input/blur so a deferred auto-flush can retry. */
  onDraftActivity?: () => void;
  /** Schedule the current draft to fire later instead of sending it now. When
   * omitted, the split-Send chevron doesn't render. The composer builds the
   * blocks from the draft and clears itself before calling. */
  onSchedule?: (blocks: ContentBlock[], fireAtUtcIso: string, recurrence: Recurrence | null) => Promise<void> | void;
  /** Resolves the active session's account's next usage-window reset (already
   * +60s-buffered), surfaced as a "Next token reset" preset in the schedule
   * popover. Omit to skip that preset. */
  getNextTokenReset?: () => Promise<Date | null> | Date | null;
}

let _composerInstanceCount = 0;

export class Composer {
  private root: HTMLElement;
  private opts: ComposerOptions;
  private sessionId: string | null = null;
  private disabled = false;
  private textarea: HTMLTextAreaElement | null = null;
  private highlightEl: HTMLElement | null = null;
  private noticeEl: HTMLElement | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private sendBtn: HTMLButtonElement | null = null;
  private scheduleBtn: HTMLButtonElement | null = null;
  private slash: SlashProvider | null = null;
  private file: FileProvider | null = null;
  private core: ComposerCore | null = null;
  private sending = false;
  // Wall-clock of the last keystroke; feeds isComposing() so an auto-flush
  // doesn't fire out from under the user mid-type.
  private lastKeyAt = 0;
  // True mid Ctrl+Z chain - lets repeated presses keep walking the queue.
  private undoChainActive = false;
  private cv: ComposerVoice;
  private ptt: ComposerPtt;
  private att: ComposerAttachments;
  private micBtn: HTMLButtonElement | null = null;
  // Cross-surface sync: debounced push + reconcile-on-open/regain-visibility.
  // One instance per Composer, itself created fresh per window/pane.
  private draftSync = new ComposerDraftSync();

  private _visibilityHandler = (): void => {
    if (document.visibilityState === "hidden") this.draftSync.flush();
    else if (document.visibilityState === "visible") void this.reconcileFromDaemon();
  };

  // An app window that is merely behind another one never fires
  // visibilitychange, so window focus is the only cue that a draft sent from
  // the phone meanwhile should disappear from an already-open chat.
  private _windowFocusHandler = (): void => {
    void this.reconcileFromDaemon();
  };

  private _globalKeydown = (e: KeyboardEvent): void => {
    if (this.disabled || !this.textarea || this.textarea.disabled) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length !== 1) return;
    const active = document.activeElement;
    if (
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLInputElement ||
      active instanceof HTMLSelectElement ||
      (active instanceof HTMLElement && active.isContentEditable)
    ) return;
    // A question card floats above the composer and owns its own free-text
    // field - route stray typing there instead of the composer textarea it
    // may be visually covering. Falls back to the composer when the card is
    // minimized or on a review panel with no free-text field of its own.
    const cardInput = document.querySelector<HTMLTextAreaElement>(
      `#${QUESTION_CARD_HOST_ID} .prompt-q__other-input, #${QUESTION_CARD_HOST_ID} .prompt-extra-input`,
    );
    const target = cardInput ?? this.textarea;
    target.focus();
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    target.value = target.value.slice(0, start) + e.key + target.value.slice(end);
    target.selectionStart = target.selectionEnd = start + 1;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    e.preventDefault();
  };

  constructor(root: HTMLElement, opts: ComposerOptions) {
    this.root = root;
    this.opts = opts;
    this.cv = new ComposerVoice({
      onAfterEdit: () => { this.autoResize(); this.updateHighlight(); this.persistDraft(); this.opts.onDraftActivity?.(); },
      onHighlightOnly: () => this.updateHighlight(),
    });
    // Push-to-talk (desktop only): hold the bound key / mouse side-button to
    // record, release to stop.
    this.ptt = new ComposerPtt({
      start: (pos) => this.cv.startForPtt(pos),
      stop: () => this.cv.stopForPtt(),
      currentInsertPos: () => this.currentInsertPos(),
      isMobile: () => isMobileViewport(),
      isDisabled: () => this.disabled,
    });
    this.att = new ComposerAttachments({
      getSessionId: () => this.sessionId,
      onChange: () => this.updateScheduleBtnState(),
    });
    // Establish positioning context so the absolute-anchored popup lands
    // above the composer instead of falling back to a distant ancestor.
    if (getComputedStyle(this.root).position === "static") {
      this.root.style.position = "relative";
    }
    this.slash = new SlashProvider();
    // Repaint once the registry lands so already-typed /commands colorize.
    void this.slash.start(opts.projectDir ?? null).then(() => this.updateHighlight());
    this.file = new FileProvider();
    this.file.start(opts.projectDir ?? null);
    this.render();
    document.addEventListener("keydown", this._globalKeydown);
    document.addEventListener("visibilitychange", this._visibilityHandler);
    window.addEventListener("focus", this._windowFocusHandler);
    shortcuts.register("blur-composer", () => { this.textarea?.blur(); });
    this.ptt.mount();
    _composerInstanceCount++;
    if (_composerInstanceCount > 1) {
      console.warn(
        `[composer] ${_composerInstanceCount} instances alive — leak suspect`,
      );
    }
  }

  destroy(): void {
    document.removeEventListener("keydown", this._globalKeydown);
    document.removeEventListener("visibilitychange", this._visibilityHandler);
    window.removeEventListener("focus", this._windowFocusHandler);
    shortcuts.unregister("blur-composer");
    this.draftSync.flush(); // not cancel - a teardown mid-debounce must not lose the last edit
    this.ptt.destroy();
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
    this.cv.destroy();
    this.core?.destroy();
    this.core = null;
    this.slash?.stop();
    this.slash = null;
    this.file?.stop();
    this.file = null;
    _composerInstanceCount = Math.max(0, _composerInstanceCount - 1);
  }

  setSessionId(id: string, opts: { readOnly?: boolean } = {}): void {
    const prevId = this.sessionId;
    const inMemoryDraft = this.textarea?.value ?? "";
    const isRename = !!prevId && prevId !== id;
    // Migrate any stored draft when a pending placeholder swaps to its real
    // session id, so the persisted text follows the session across the rename.
    if (isRename) {
      this.draftSync.flush(); // the outgoing session may become unreachable - don't lose its edit
      const prevStored = loadDraft(prevId!);
      if (prevStored && !loadDraft(id)) saveDraft(id, prevStored);
      clearDraft(prevId!);
      this.att.migrateSession(prevId!, id);
      moveSentOutbox(prevId!, id);
    }
    this.sessionId = id;
    this.disabled = !!opts.readOnly;
    this.draftSync.setSession();
    this.render();
    const stored = loadDraft(id);
    const restored = inMemoryDraft || stored || "";
    if (this.textarea && restored) {
      this.textarea.value = restored;
      this.autoResize();
      this.updateHighlight();
      if (stored && !inMemoryDraft) saveDraft(id, stored);
    }
    // A placeholder->real rename: the daemon never knew the placeholder id.
    if (isRename && restored) {
      this.draftSync.notifyTyped(id, restored);
      this.draftSync.flush();
    }
    // Refresh DOM so any in-memory attachments are visible in the rebuilt
    // .composer-attachments host, then async-rehydrate any persisted metas
    // from disk.
    this.att.render();
    void this.att.hydrate(id);
    void this.reconcileFromDaemon(); // one round trip on session open; guards focus itself
  }

  /** Apply the daemon's composer draft if it's newer and this composer isn't
   *  currently focused - NEVER overwrite an input the user is typing into. */
  private async reconcileFromDaemon(): Promise<void> {
    const sid = this.sessionId;
    if (!sid) return;
    const remoteText = await this.draftSync.reconcile(sid);
    if (remoteText === null) return;
    if (document.activeElement === this.textarea) return;
    if (!this.textarea || this.textarea.value === remoteText) return;
    this.textarea.value = remoteText;
    // "" is the daemon's clear tombstone - another surface sent this draft,
    // so drop the local copy too instead of storing an empty string.
    if (remoteText) saveDraft(sid, remoteText);
    else clearDraft(sid);
    this.autoResize();
    this.updateHighlight();
  }

  /** Idle placeholder text. Blocked (rate-limited but still enabled) beats the
   * default copy; read-only beats blocked (a read-only pane can't be blocked
   * in a way that matters to the user). */
  private computePlaceholder(): string {
    if (this.disabled) return "Read-only - click Take over to interact";
    const blocked = this.opts.isBlocked?.();
    if (blocked?.placeholder) return blocked.placeholder;
    return isMobileViewport()
      ? "Type a message. Tap send to send."
      : "Type a message. Shift+Enter for newline. Paste images.";
  }

  /** Re-check isBlocked() and refresh the idle placeholder without a full
   * re-render. Called by the chat pane whenever instances-changed lands, so
   * the composer reflects a block/reset that happened while it was mounted. */
  refreshBlockedState(): void {
    if (this.textarea) this.textarea.placeholder = this.computePlaceholder();
  }

  private showNotice(text: string): void {
    if (!this.noticeEl) return;
    this.noticeEl.textContent = text;
    this.noticeEl.hidden = false;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      if (this.noticeEl) this.noticeEl.hidden = true;
    }, 4000);
  }

  private render(): void {
    const placeholder = this.computePlaceholder();
    // .composer-file-input's native-picker click is mobile-only (the "Attach
    // image" menu item); narrowed from a mixed accept list so Android favours
    // its streamlined Photo Picker over the generic Files app, which appeared
    // to silently drop the picked file on-device (ai_todo 409).
    this.root.innerHTML = `
      <div class="composer-attachments"></div>
      <div class="composer-row">
        <div class="composer-input-wrap cc-typing-wrap">
          <div class="composer-highlight cc-typing-highlight" aria-hidden="true"></div>
          <textarea class="composer-textarea cc-typing-input" rows="1" placeholder="${placeholder}" ${this.disabled ? "disabled" : ""}></textarea>
        </div>
        <div class="composer-actions">
          <button class="composer-mic icon-btn" ${this.disabled ? "disabled" : ""} title="Voice dictation (tap to start/stop)">
            <i class="ph ph-microphone"></i>
          </button>
          <div class="composer-send-split">
            <button class="composer-send icon-btn" ${this.disabled ? "disabled" : ""} title="Send">
              <i class="ph ph-paper-plane-right"></i>
            </button>
            <button class="composer-send-chevron icon-btn" ${this.disabled ? "disabled" : ""} title="More actions">
              <i class="ph ph-caret-down"></i>
            </button>
          </div>
        </div>
      </div>
      <div class="composer-notice" hidden></div>
      <input type="file" class="composer-file-input" accept="image/*" multiple hidden>
    `;
    this.textarea = this.root.querySelector<HTMLTextAreaElement>(".composer-textarea");
    this.highlightEl = this.root.querySelector<HTMLElement>(".composer-highlight");
    this.noticeEl = this.root.querySelector<HTMLElement>(".composer-notice");
    this.sendBtn = this.root.querySelector<HTMLButtonElement>(".composer-send");
    this.scheduleBtn = this.root.querySelector<HTMLButtonElement>(".composer-send-chevron");
    this.micBtn = this.root.querySelector<HTMLButtonElement>(".composer-mic");
    this.att.bind(this.root);
    // The popup/highlight backdrop were inside root.innerHTML, so they're
    // gone after the swap. Rebuild the core on every render (mirrors the
    // instance-per-mount contract the popup already used) and keep the
    // provider's cache.
    this.core?.destroy();
    this.core = null;
    if (this.textarea) {
      const interactive = !this.disabled && !!this.slash && !!this.file;
      this.core = new ComposerCore({
        textarea: this.textarea,
        highlightEl: this.highlightEl,
        anchor: this.root,
        providers: interactive
          ? ([this.slash, this.file] as unknown as SuggestProvider<unknown>[])
          : [],
        paste: interactive ? { handlePaste: (e) => this.att.handlePaste(e) } : undefined,
        computeHighlightHtml: () => this.computeHighlightHtml(),
        onInput: interactive
          ? () => {
              this.lastKeyAt = Date.now();
              this.undoChainActive = false;
              this.persistDraft();
              this.updateScheduleBtnState();
              this.opts.onDraftActivity?.();
            }
          : undefined,
        onEnter: interactive ? () => void this.send() : undefined,
        onCtrlEnter: interactive ? () => this.handleCtrlEnter() : undefined,
        onUndoQueued: interactive ? () => this.handleUndoQueued() : undefined,
        // An Escape that closed the "/"-suggest popup must not also fall
        // through to the document-level blur-composer shortcut.
        stopPropagationOnPopupConsume: true,
        isMobileViewport: () => isMobileViewport(),
        onResize: (scrollHeight) => {
          this.root.querySelector<HTMLElement>(".composer-row")?.classList.toggle("composer-row--tall", scrollHeight > 44);
        },
      });
    }
    if (!this.disabled && this.textarea && this.slash && this.file) {
      this.textarea.addEventListener("blur", () => {
        this.opts.onDraftActivity?.();
        this.draftSync.flush();
      });
      this.sendBtn?.addEventListener("click", () => void this.send());
      this.scheduleBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.disabled || !this.scheduleBtn) return;
        this.openActionsMenu(this.scheduleBtn);
      });
      this.att.wireInteractive();
      this.micBtn?.addEventListener("click", () => {
        if (this.disabled) return;
        this.textarea?.focus();
        const pos = this.textarea?.selectionStart ?? this.textarea?.value.length ?? 0;
        void this.cv.toggle(pos);
      });
      // Re-warm the STT sidecar on hover so a stale (idle-shut-down) engine is
      // hot again by the time the click lands. Throttled inside warm().
      this.micBtn?.addEventListener("pointerenter", () => {
        if (!this.disabled) this.cv.warm();
      });
      if (this.micBtn && this.textarea) {
        this.cv.mount(this.micBtn, this.textarea);
        // Chat is now open: pre-warm so the first dictation click is instant.
        this.cv.warm();
      }
    }
    this.autoResize();
    this.updateHighlight();
    this.updateScheduleBtnState();
  }

  /** Chevron is disabled while read-only or the draft (text + attachments +
   * pasted blocks) is empty — mirrors isDraftEmpty()'s definition of "empty". */
  private updateScheduleBtnState(): void {
    // The chevron now opens the actions menu (voice/attach are available even
    // with an empty draft), so it's only disabled when the composer is read-only.
    if (this.scheduleBtn) this.scheduleBtn.disabled = this.disabled;
  }

  private autoResize(): void {
    this.core?.autoResize();
  }

  // Repaint the highlight backdrop (colors known /slash commands) behind the
  // transparent-text textarea, and keep it scroll-aligned. Delegates to the
  // shared core; computeHighlightHtml() below supplies the voice-volatile
  // split this composer alone needs.
  private updateHighlight(): void {
    this.core?.updateHighlight();
  }

  // While recording, paint the volatile (still-revising) voice tail faintly so
  // it reads as "live, not yet committed". Committed voice text renders
  // normally. Voice/PTT stay main-composer-only, so this stays here rather
  // than in the shared core.
  private computeHighlightHtml(): string {
    const val = this.textarea?.value ?? "";
    if (this.cv.state === "recording" && this.cv.volatileLen > 0) {
      const a = val.slice(0, this.cv.commitPos);
      const vol = val.slice(this.cv.commitPos, this.cv.commitPos + this.cv.volatileLen);
      const b = val.slice(this.cv.commitPos + this.cv.volatileLen);
      return (
        highlightComposerInput(a) +
        `<span class="voice-volatile">${highlightComposerInput(vol)}</span>` +
        highlightComposerInput(b)
      );
    }
    return highlightComposerInput(val);
  }

  /** Mobile = the same 768px breakpoint the sessions layout uses to switch to
   *  single-pane mode. On a soft keyboard there is no easy Shift+Enter, so a
   *  bare Enter must insert a newline (the send button sends instead). */
  private currentInsertPos(): number {
    return this.textarea?.selectionStart ?? this.textarea?.value.length ?? 0;
  }

  /** Build + open the split-send chevron menu: Voice + (mobile-only) Attach +
   *  Schedule. Voice lives here on both platforms now - the mic button itself
   *  only surfaces while actively recording (see composer-mic in voice.css).
   *  Schedule only appears with content to schedule. */
  private openActionsMenu(anchor: HTMLElement): void {
    const items: ComposerMenuItem[] = [];
    // Re-warm on menu open so Voice is hot by the time it's clicked, even if
    // the sidecar idle-shut-down since the chat opened. Throttled inside warm().
    this.cv.warm();
    items.push({
      icon: "microphone",
      label: "Voice dictation",
      run: () => {
        this.textarea?.focus();
        void this.cv.toggle(this.currentInsertPos());
      },
    });
    if (isMobileViewport()) {
      items.push({
        icon: "image",
        label: "Attach image",
        run: () => this.att.openFilePicker(),
      });
    }
    if (this.opts.onSchedule && !this.isDraftEmpty()) {
      items.push({ icon: "clock", label: "Schedule message", run: () => this.openSchedule(anchor) });
    }
    openComposerMenu(anchor, items);
  }

  private openSchedule(anchor: HTMLElement): void {
    if (this.isDraftEmpty()) return;
    openSchedulePicker({
      anchor,
      nextTokenReset: this.opts.getNextTokenReset?.(),
      onConfirm: (result) => {
        const text = (this.textarea?.value ?? "").trim();
        const blocks = this.buildBlocks(text);
        this.clearComposer();
        void this.opts.onSchedule?.(blocks, result.fireAtUtcIso, result.recurrence);
      },
    });
  }

  /** Drop files onto the composer (e.g. a future external drop zone). */
  async dropFiles(files: Iterable<File>): Promise<void> {
    return this.att.dropFiles(files);
  }

  /** Attach a file already on disk by path. Called by sessions.ts's
   * `tauri://drag-drop` listener, the actual working drop path in Tauri v2. */
  async attachFromPath(srcPath: string): Promise<void> {
    return this.att.attachFromPath(srcPath);
  }

  private builtinCtx(): BuiltinContext {
    return {
      sessionId: this.sessionId,
      projectDir: this.opts.projectDir ?? null,
      getRenderer: this.opts.getRenderer ?? (() => null),
      pane: this.root.closest<HTMLElement>(".session-pane") ?? this.root.parentElement,
    };
  }

  /** Ctrl/Cmd+Enter with an empty draft and a queued (held) set sends the
   *  queue immediately, busy or not - the same action as the chip's "Send
   *  now". Any other case (draft has content, or nothing queued) falls
   *  through to the normal send() path unchanged. */
  private handleCtrlEnter(): void {
    if (this.isDraftEmpty() && this.opts.hasHeld?.()) {
      void this.opts.sendQueuedNow?.();
      return;
    }
    void this.send();
  }

  /** Ctrl/Cmd+Z: pop the last queued message back into the draft, then the
   *  sent-outbox. Both empty declines, handing back to native text-undo. */
  private handleUndoQueued(): boolean {
    if (!this.isDraftEmpty() && !this.undoChainActive) return false;
    const blocks = this.opts.popLastHeld?.();
    const popped = blocks
      ? blocksToText(blocks)
      : (this.sessionId ? popLastSent(this.sessionId) : null);
    if (popped === null) return false;
    const rest = this.undoChainActive ? (this.textarea?.value ?? "") : "";
    this.setDraftText(rest ? `${popped}\n\n${rest}` : popped);
    this.undoChainActive = true;
    return true;
  }

  private async send(): Promise<void> {
    if (this.disabled) return;
    if (this.sending) {
      console.warn("[composer] re-entry blocked — double-fire suspect");
      return;
    }
    const text = (this.textarea?.value ?? "").trim();
    const empty = !text && this.att.isEmpty();

    const builtin = text ? parseBuiltin(text) : null;
    if (builtin) {
      this.sending = true;
      const handler = HANDLERS[builtin.name];
      if (handler) {
        try {
          await handler(builtin, this.builtinCtx());
        } catch (e) {
          console.error("[builtin]", builtin.name, e);
        }
      }
      this.clearComposer();
      this.sending = false;
      return;
    }

    // Every branch below clears the box, and several can end without the text
    // reaching the daemon. Ctrl+Z walks this back even when nothing surfaced.
    if (text && this.sessionId) recordSent(this.sessionId, text);

    // Account is out of usage: schedule the draft for the reset instead of
    // sending (or staging) it now. Skips the schedule-picker popover - the
    // fire time is dictated by the daemon's own reset+60s delay, not a
    // user-picked time. Builtins above still run immediately.
    const blocked = this.opts.isBlocked?.();
    if (blocked) {
      if (empty) return;
      this.sending = true;
      const blocks = this.buildBlocks(text);
      const savedBlockedAttachments = this.att.attachments;
      const savedBlockedPastedBlocks = this.att.pastedBlocks;
      this.clearComposer();
      try {
        await this.opts.onSchedule?.(blocks, blocked.resetsAtIso, null);
        this.showNotice(`Scheduled for ${blocked.resetsAtLabel}.`);
      } catch (err) {
        console.error("[Composer] blocked-schedule failed", err);
        this.restoreDraft(text, savedBlockedAttachments, savedBlockedPastedBlocks);
      } finally {
        this.sending = false;
      }
      return;
    }

    // Frozen: ask hold-vs-send-now instead of silently staging like busy does
    // - freezes can persist indefinitely, so ask every time, not just once.
    if (this.opts.isFrozen?.()) {
      if (empty) return;
      const anchor = this.sendBtn ?? this.textarea;
      if (!anchor) return;
      // Set before the await, not after: the choice popover is async, and
      // an Enter re-fired while it's still open must not re-enter this
      // branch and stack a second popover on top of the first.
      this.sending = true;
      const choice = await openFrozenChoice(anchor);
      if (choice === null) {
        this.sending = false;
        return; // dismissed - draft stays put
      }
      const blocks = this.buildBlocks(text);
      const savedAttachments = this.att.attachments;
      const savedPastedBlocks = this.att.pastedBlocks;
      this.clearComposer();
      try {
        if (choice === "hold") {
          this.opts.onStage?.(blocks);
        } else {
          await this.opts.onSend(blocks);
        }
      } catch (err) {
        console.error("[Composer] frozen-choice send failed", err);
        this.restoreDraft(text, savedAttachments, savedPastedBlocks);
      } finally {
        this.sending = false;
      }
      return;
    }

    // While the turn is in flight: stage as a held message instead of sending.
    // Builtins above still run immediately; only real messages are held.
    if (this.opts.isBusy?.()) {
      if (empty) return;
      // Staging into an unattached controller no-ops, so clear only once taken.
      if (this.opts.onStage?.(this.buildBlocks(text)) === false) {
        this.showNotice("Couldn't queue that - your message is still here.");
        return;
      }
      this.clearComposer();
      return;
    }

    // Not busy, but a held set exists: a normal send bundles the held messages
    // with this draft into ONE message (handled by the held controller).
    if (this.opts.hasHeld?.()) {
      const draftBlocks = empty ? [] : this.buildBlocks(text);
      const savedHeldAttachments = this.att.attachments;
      const savedHeldPastedBlocks = this.att.pastedBlocks;
      this.clearComposer();
      void Promise.resolve(this.opts.flushHeldWithDraft?.(draftBlocks)).then((ok) => {
        if (ok !== false) return;
        this.restoreDraft(text, savedHeldAttachments, savedHeldPastedBlocks);
        this.showNotice("Couldn't send that - your message is still here.");
      });
      return;
    }

    if (empty) return;
    this.sending = true;
    const blocks = this.buildBlocks(text);
    const savedAttachments = this.att.attachments;
    const savedPastedBlocks = this.att.pastedBlocks;
    this.clearComposer();
    try {
      await this.opts.onSend(blocks);
    } catch (err) {
      console.error("[Composer] onSend failed", err);
      this.restoreDraft(text, savedAttachments, savedPastedBlocks);
    } finally {
      this.sending = false;
    }
  }

  /** Build the ContentBlock[] for the current draft: typed text + any held
   * pasted-log sentinels + attachment <file:…> mentions. Pure (no clear). The
   * <pasted-log> wrapper is collapsed into a chip by the chat renderer so the
   * user never sees the wall of text in their own message. */
  private buildBlocks(text: string): ContentBlock[] {
    let fullText = text;
    for (const b of this.att.pastedBlocks) {
      const nonce = Math.random().toString(36).slice(2, 10);
      const wrapped = `<pasted-log id="${nonce}" name="${b.name}">\n${b.text}\n</pasted-log:${nonce}>`;
      fullText += (fullText ? "\n\n" : "") + wrapped;
    }
    // Mark voice-dictated messages so the model reads them charitably (homophones,
    // transcription noise); the renderer collapses this into a mic chip.
    if (this.cv.isUsed) {
      fullText += (fullText ? "\n" : "") + "<voice-input/>";
    }
    const blocks: ContentBlock[] = [];
    if (fullText) blocks.push({ type: "text", text: fullText });
    for (const a of this.att.attachments) {
      if (a.path) {
        blocks.push({ type: "text", text: `<file:${a.path}::${a.filename}>` });
      } else {
        blocks.push({
          type: "text",
          text: "[attachment dropped - paste_attachment IPC not available]",
        });
      }
    }
    return blocks;
  }

  /** Focus the textarea. Public so the held-messages controller can return
   * focus here after closing the unsent-messages dropdown. */
  focus(): void {
    this.textarea?.focus();
  }

  /** Reset the input, attachments, pasted blocks and persisted draft. Public so
   * the held-messages controller can clear after bundling the draft. */
  clearComposer(): void {
    if (this.textarea) this.textarea.value = "";
    this.autoResize();
    this.updateHighlight();
    // Reset voice state; stop an in-flight recording so a send mid-dictation
    // doesn't leave the controller running against stale anchor positions.
    this.cv.reset();
    this.att.clear();
    // Explicit clear: send/discard only, never blur or navigate-away.
    if (this.sessionId) {
      clearDraft(this.sessionId);
      void this.draftSync.clear(this.sessionId);
    }
  }

  /** Undo a `clearComposer()` after a failed send: puts the text, attachments
   * and pasted blocks back so the user doesn't lose what they typed. */
  private restoreDraft(text: string, attachments: Attachment[], pastedBlocks: PastedBlock[]): void {
    if (this.textarea) {
      this.textarea.value = text;
      this.textarea.focus();
    }
    this.att.restoreDraft(attachments, pastedBlocks);
    this.autoResize();
    this.updateHighlight();
    this.persistDraft();
  }

  /** Replace the draft's text. `clearAttachments` (default true) also wipes
   * staged attachments/pasted blocks - used by the scheduled-message-edit
   * caller, which only stores a flattened prompt string. The lightbox caption
   * round-trip passes false so dismissing a preview never drops attachments. */
  setDraftText(text: string, clearAttachments = true): void {
    this.undoChainActive = false;
    if (clearAttachments) this.att.clear();
    if (this.textarea) {
      this.textarea.value = text;
      this.textarea.focus();
    }
    this.autoResize();
    this.updateHighlight();
    this.persistDraft();
    this.opts.onDraftActivity?.();
  }

  /** Plain text of the current draft, attachments aside (lightbox draft mirror). */
  getDraftText(): string {
    return this.textarea?.value ?? "";
  }

  /** Build blocks for the current draft without clearing it (for bundling). */
  getDraftBlocks(): ContentBlock[] {
    const text = (this.textarea?.value ?? "").trim();
    if (this.isDraftEmpty()) return [];
    return this.buildBlocks(text);
  }

  isDraftEmpty(): boolean {
    const text = (this.textarea?.value ?? "").trim();
    return !text && this.att.isEmpty();
  }

  /** Programmatically send a plain-text message, bypassing busy/held checks.
   * On failure, surfaces the failed text in the composer for manual retry -
   * but only when the box is empty, so this can never clobber an unrelated
   * draft the user already had typed. */
  async sendText(text: string): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    const blocks: ContentBlock[] = [{ type: "text", text }];
    try {
      await this.opts.onSend(blocks);
    } catch (err) {
      console.error("[Composer] sendText failed", err);
      if (this.isDraftEmpty()) this.setDraftText(text);
    } finally {
      this.sending = false;
    }
  }

  /** True while the user is actively composing: focused with a non-empty draft,
   * or a keystroke within the last 2s. Gates auto-flush. */
  isComposing(): boolean {
    if (!this.textarea) return false;
    const hasText = (this.textarea.value ?? "").trim().length > 0;
    const focused = document.activeElement === this.textarea;
    if (focused && hasText) return true;
    return Date.now() - this.lastKeyAt < 2000;
  }

  private persistDraft(): void {
    if (!this.sessionId) return;
    const text = this.textarea?.value ?? "";
    if (text) saveDraft(this.sessionId, text);
    else clearDraft(this.sessionId);
    this.draftSync.notifyTyped(this.sessionId, text); // even "" - discard/send clears explicitly instead
  }
}
