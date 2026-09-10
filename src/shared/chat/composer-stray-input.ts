// Stray-input relay for the Composer: a keystroke or paste that lands on no
// editable element (focus is outside any textarea/input/contenteditable)
// routes into an open AUQ card's free-text field if one exists, else the
// composer itself, instead of being silently dropped. Split out of
// composer.ts (ai_todo 876), same callback-bag shape as
// ComposerUndo/ComposerHighlight/ComposerVoice.

import { HOST_ID as QUESTION_CARD_HOST_ID } from "../../views/sessions/permission-modal/host";
import { isAnyModalOpen } from "../modal-input-lock";
import { PASTE_LOG_THRESHOLD, clipboardHasFile } from "./composer-attachments";

export interface ComposerStrayInputCallbacks {
  getTextarea: () => HTMLTextAreaElement | null;
  isDisabled: () => boolean;
  /** Route a paste event to the attachment layer (images / oversized logs). */
  handlePaste: (e: ClipboardEvent) => void;
}

export class ComposerStrayInput {
  constructor(private cb: ComposerStrayInputCallbacks) {}

  /** Where input that landed on no editable element belongs, or null to leave
   * the event alone. An open question card owns its own free-text field and
   * floats over the composer, so it wins; the composer is the fallback. */
  private target(): HTMLTextAreaElement | null {
    const textarea = this.cb.getTextarea();
    if (this.cb.isDisabled() || !textarea || textarea.disabled) return null;
    // A modal's focused control (e.g. askConfirm's Cancel button) is
    // non-editable, so modal-input-lock lets the event bubble here - this
    // must not hijack it just because activeElement isn't a field.
    if (isAnyModalOpen()) return null;
    const active = document.activeElement;
    if (
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLInputElement ||
      active instanceof HTMLSelectElement ||
      (active instanceof HTMLElement && active.isContentEditable)
    ) return null;
    const cardInput = document.querySelector<HTMLTextAreaElement>(
      `#${QUESTION_CARD_HOST_ID} .prompt-q__other-input, #${QUESTION_CARD_HOST_ID} .prompt-extra-input`,
    );
    return cardInput ?? textarea;
  }

  private insert(target: HTMLTextAreaElement, text: string): void {
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    target.value = target.value.slice(0, start) + text + target.value.slice(end);
    target.selectionStart = target.selectionEnd = start + text.length;
    target.dispatchEvent(new Event("input", { bubbles: true }));
  }

  private onKeydown = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length !== 1) return;
    const target = this.target();
    if (!target) return;
    target.focus();
    this.insert(target, e.key);
    e.preventDefault();
  };

  // Paste half of onKeydown's type-anywhere behaviour: that handler skips
  // modifier chords, and the browser drops a paste with no editable focused.
  private onPaste = (e: ClipboardEvent): void => {
    const target = this.target();
    if (!target) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    const hasFile = clipboardHasFile(e.clipboardData);
    // Focusing mid-event doesn't redirect the default action (it was already
    // bound to <body>), so this handler has to place the payload itself.
    e.preventDefault();
    target.focus();
    // Images and oversized logs are the attachment layer's job, but only for
    // the composer - the AUQ card keeps its own separate attachment store.
    if (target === this.cb.getTextarea() && (hasFile || text.length >= PASTE_LOG_THRESHOLD)) {
      this.cb.handlePaste(e);
      return;
    }
    if (text) this.insert(target, text);
  };

  mount(): void {
    document.addEventListener("keydown", this.onKeydown);
    document.addEventListener("paste", this.onPaste);
  }

  destroy(): void {
    document.removeEventListener("keydown", this.onKeydown);
    document.removeEventListener("paste", this.onPaste);
  }
}
