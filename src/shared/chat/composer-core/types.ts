import type { SuggestProvider } from "../caret-popup/types";

export interface ComposerCoreFeatures {
  /** "/" and "@" suggestion popup (CaretSuggestPopup). Default true when
   *  `providers` is non-empty. */
  popup?: boolean;
  /** Colored token backdrop behind a transparent-text textarea. Default true
   *  when `highlightEl` is given. */
  highlight?: boolean;
  /** Route paste events through `paste`. Default true when `paste` is given. */
  paste?: boolean;
  /** CSS field-sizing (with a JS scrollHeight fallback). Default true. */
  autoResize?: boolean;
}

/** Host-supplied paste handling. The core never touches attachment storage
 *  itself - each surface keeps its own shape (Composer's `Attachment` vs the
 *  AUQ card's `AuqAttachment`) and persistence rules; the core only forwards
 *  the event. */
export interface ComposerCorePasteAdapter {
  handlePaste(e: ClipboardEvent): void | Promise<void>;
}

export interface ComposerCoreOptions {
  textarea: HTMLTextAreaElement;
  /** Backdrop element painted behind the textarea. Its CSS (font/padding/
   *  border) must match the textarea exactly - see markdown-highlight.ts's
   *  `highlightComposerInput` doc. Owned/styled by the host, not the core. */
  highlightEl?: HTMLElement | null;
  /** Popup anchor; forced to `position: relative` if computed as static.
   *  Defaults to `textarea.parentElement`. */
  anchor?: HTMLElement | null;
  /** Suggestion providers for the popup. Host owns their start()/stop()
   *  lifecycle (may be shared across several ComposerCore mounts, e.g. one
   *  SlashProvider reused by every textarea on an AUQ card). */
  providers?: SuggestProvider<unknown>[];
  paste?: ComposerCorePasteAdapter;
  features?: ComposerCoreFeatures;
  /** Overrides the default `highlightComposerInput(textarea.value)` painting
   *  (e.g. Composer's voice-dictation volatile-tail split). Most hosts omit
   *  this and get the plain default. */
  computeHighlightHtml?: () => string;
  /** Fired after every input-driven autoResize/highlight/popup update. */
  onInput?: () => void;
  /** Fired on a bare Enter (no Shift, not on a mobile viewport, and not
   *  consumed by an open popup). Omit for surfaces where Enter should just
   *  insert a newline (the default textarea behavior). */
  onEnter?: () => void;
  /** Fired on Ctrl/Cmd+Enter (no Shift), instead of `onEnter`, when supplied.
   *  Only the main Composer uses this today (queued-message send shortcut);
   *  other hosts omit it and Ctrl+Enter falls through to `onEnter` as before. */
  onCtrlEnter?: () => void;
  /** Overrides the default 768px matchMedia check (mirrors Composer's
   *  isMobileViewport: on a soft keyboard there's no easy Shift+Enter, so a
   *  bare Enter must insert a newline instead of submitting). */
  isMobileViewport?: () => boolean;
  /** Call `e.stopPropagation()` when the popup consumes a keydown (e.g.
   *  Escape closing the suggestion list). Off by default (matches the main
   *  Composer, which has no ancestor keydown listener to guard against).
   *  The AUQ card needs this ON: its document-level Escape-cancels-the-card
   *  handler would otherwise also fire on the same keypress that closed the
   *  popup, since keydown bubbles past the textarea by default. */
  stopPropagationOnPopupConsume?: boolean;
  /** Fired after autoResize with the textarea's current scrollHeight, so a
   *  host can toggle its own chrome (e.g. Composer's `.composer-row--tall`). */
  onResize?: (scrollHeight: number) => void;
  /** Fired on Ctrl/Cmd+Z before native text-undo runs. Return true to consume
   *  it (a queued message was popped back); false lets native undo proceed. */
  onUndoQueued?: () => boolean;
}
