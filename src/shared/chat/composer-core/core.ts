// Shared typing-experience core: "/" skill-suggestion popup, colored token
// highlighting, paste routing, and auto-resize - the parts of the composer
// that must behave identically everywhere text is typed (main composer, AUQ
// card, preview-panel input). Voice/PTT, schedule-send, and builtin-command
// EXECUTION stay main-composer-only, layered on top of this by Composer
// itself (ai_todo composer-unification).
//
// Instance-per-mount, same contract as CaretSuggestPopup: a host that
// rebuilds its DOM via innerHTML destroys the old core and constructs a
// fresh one against the new textarea. The core holds no authoritative text
// state of its own - the host's own draft state (freeText map, localStorage
// draft, etc.) already re-feeds the new textarea's initial value through its
// own render(), so there is nothing for the core to snapshot or restore on
// remount. destroy() is safe to call even if the textarea has already been
// removed from the DOM (removeEventListener on a detached node is a no-op,
// never a throw).

import { CaretSuggestPopup } from "../caret-popup/popup";
import { highlightComposerInput } from "../markdown-highlight";
import { isMobileViewport } from "../../mobile-viewport";
import type { ComposerCoreOptions } from "./types";

export type { ComposerCoreOptions, ComposerCoreFeatures, ComposerCorePasteAdapter } from "./types";

// jsdom's `CSS` global exists but doesn't implement `.supports` in every
// version (hit in the unit-test environment once this module's import graph
// widened past the main composer) - guard the method itself, not just the
// global, so this stays a false/no-throw feature-miss there instead of a
// module-load crash.
const supportsFieldSizing =
  typeof CSS !== "undefined" &&
  typeof CSS.supports === "function" &&
  CSS.supports("field-sizing", "content");

export class ComposerCore {
  private opts: ComposerCoreOptions;
  private popup: CaretSuggestPopup | null = null;

  private onKeydown = (e: KeyboardEvent): void => {
    if (this.popup?.handleKey(e)) {
      if (this.opts.stopPropagationOnPopupConsume) e.stopPropagation();
      return;
    }
    // Ctrl/Cmd+Enter takes onCtrlEnter when the host supplies one (only the
    // main Composer does, for its queued-message shortcut) - fires even on
    // mobile, since the modifier implies a physical keyboard is attached.
    if (e.key === "Enter" && !e.shiftKey && (e.ctrlKey || e.metaKey) && this.opts.onCtrlEnter) {
      e.preventDefault();
      this.opts.onCtrlEnter();
      return;
    }
    // Gated on onEnter itself (not just !!onEnter above the call) so a host
    // that omits it - per this option's own documented contract - actually
    // gets the plain-newline default instead of a silently eaten keystroke.
    if (e.key === "Enter" && !e.shiftKey && this.opts.onEnter) {
      const mobile = (this.opts.isMobileViewport ?? isMobileViewport)();
      if (mobile) return;
      e.preventDefault();
      this.opts.onEnter();
    }
  };

  private onInputEvt = (): void => {
    this.handleInput();
  };

  // Skip keys popup.handleKey() already consumed (it preventDefault()s the
  // caret move) - resyncing here too would re-query and reset selectedIdx.
  private static readonly POPUP_NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"]);

  private onCaretMoveEvt = (e: Event): void => {
    if (e instanceof KeyboardEvent && ComposerCore.POPUP_NAV_KEYS.has(e.key)) return;
    this.popup?.handleInput();
  };

  private onPasteEvt = (e: ClipboardEvent): void => {
    void this.opts.paste?.handlePaste(e);
  };

  private onScrollEvt = (): void => {
    const { highlightEl, textarea } = this.opts;
    if (highlightEl) highlightEl.scrollTop = textarea.scrollTop;
  };

  constructor(opts: ComposerCoreOptions) {
    this.opts = opts;
    const { textarea, features = {} } = opts;

    if (features.popup !== false && opts.providers?.length) {
      const anchor = opts.anchor ?? textarea.parentElement;
      if (anchor) {
        if (getComputedStyle(anchor).position === "static") anchor.style.position = "relative";
        this.popup = new CaretSuggestPopup({ anchor, textarea, providers: opts.providers });
      }
    }

    textarea.addEventListener("keydown", this.onKeydown);
    textarea.addEventListener("input", this.onInputEvt);
    if (this.popup) {
      textarea.addEventListener("click", this.onCaretMoveEvt);
      textarea.addEventListener("keyup", this.onCaretMoveEvt);
    }
    if (features.paste !== false && opts.paste) {
      textarea.addEventListener("paste", this.onPasteEvt);
    }
    if (features.highlight !== false && opts.highlightEl) {
      textarea.addEventListener("scroll", this.onScrollEvt);
      this.updateHighlight();
    }
    if (features.autoResize !== false) this.autoResize();
  }

  /** Idempotent; safe to call before or after the textarea leaves the DOM. */
  destroy(): void {
    const { textarea } = this.opts;
    textarea.removeEventListener("keydown", this.onKeydown);
    textarea.removeEventListener("input", this.onInputEvt);
    textarea.removeEventListener("click", this.onCaretMoveEvt);
    textarea.removeEventListener("keyup", this.onCaretMoveEvt);
    textarea.removeEventListener("paste", this.onPasteEvt);
    textarea.removeEventListener("scroll", this.onScrollEvt);
    this.popup?.destroy();
    this.popup = null;
  }

  /** Re-run the input-driven pipeline (autoResize -> highlight -> popup ->
   *  onInput). Exposed so a host that programmatically edits the textarea
   *  value (e.g. picking a popup suggestion elsewhere) can trigger the same
   *  refresh a real keystroke would. */
  handleInput(): void {
    const { features = {} } = this.opts;
    if (features.autoResize !== false) this.autoResize();
    if (features.highlight !== false) this.updateHighlight();
    this.popup?.handleInput();
    this.opts.onInput?.();
  }

  autoResize(): void {
    const ta = this.opts.textarea;
    if (supportsFieldSizing) {
      // CSS field-sizing: content auto-grows the textarea; clear any inline
      // height override so it takes over.
      ta.style.height = "";
    } else {
      ta.style.height = "auto";
      ta.style.height = `${ta.scrollHeight}px`;
    }
    this.opts.onResize?.(ta.scrollHeight);
  }

  /** Repaint the highlight backdrop from the textarea's current value (or
   *  `computeHighlightHtml()` when the host supplied one). */
  updateHighlight(): void {
    if (!this.opts.highlightEl) return;
    const html = this.opts.computeHighlightHtml
      ? this.opts.computeHighlightHtml()
      : highlightComposerInput(this.opts.textarea.value);
    this.setHighlightHtml(html);
  }

  /** For hosts needing custom pre-processing before painting (e.g.
   *  Composer's voice-dictation volatile-tail split) - bypasses the default
   *  highlightComposerInput(textarea.value) computation. */
  setHighlightHtml(html: string): void {
    const { highlightEl, textarea } = this.opts;
    if (!highlightEl) return;
    highlightEl.innerHTML = html;
    highlightEl.scrollTop = textarea.scrollTop;
  }
}
