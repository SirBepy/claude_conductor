// The one text box + paper-plane send button every secondary surface uses
// (Preview reply, question card, Ask, todo-step note, draft revise). It is the
// main composer's own .composer-input-wrap/.composer-highlight/
// .composer-textarea trio plus an .icon-btn send, so all of them look exactly
// like the chat composer; only the main composer adds its own extras (mic,
// schedule chevron). Enter policy comes from ComposerCore: desktop Enter
// sends, Shift+Enter is a newline, and on a phone Enter is always a newline.

import { escapeHtml } from "../escape-html";
import { ComposerCore } from "./composer-core/core";
import type { ComposerCoreOptions } from "./composer-core/types";
import "./composer.css";

export interface ComposerFieldHtmlOpts {
  placeholder: string;
  value?: string;
  /** Hook class(es) for the textarea, used by the host to find it. */
  inputClass?: string;
  /** Extra attributes for the textarea, e.g. `data-ask-input`. */
  inputAttrs?: string;
  /** Hook class(es) for the send button. */
  sendClass?: string;
  sendTitle?: string;
  /** Extra class(es) on the row, e.g. `composer-field--docked`. */
  rowClass?: string;
  /** Markup placed after the send button (e.g. the draft-revise presets). */
  after?: string;
}

export function composerFieldHtml(o: ComposerFieldHtmlOpts): string {
  const value = o.value ?? "";
  return (
    `<div class="composer-field${o.rowClass ? ` ${o.rowClass}` : ""}">` +
      `<div class="composer-input-wrap">` +
        `<div class="composer-highlight" aria-hidden="true"></div>` +
        `<textarea class="composer-textarea${o.inputClass ? ` ${o.inputClass}` : ""}" rows="1"` +
          ` placeholder="${escapeHtml(o.placeholder)}"${o.inputAttrs ? ` ${o.inputAttrs}` : ""}>${escapeHtml(value)}</textarea>` +
      `</div>` +
      `<button type="button" class="icon-btn composer-field-send${o.sendClass ? ` ${o.sendClass}` : ""}"` +
        ` title="${escapeHtml(o.sendTitle ?? "Send")}"${value.trim() ? "" : " disabled"}>` +
        `<i class="ph ph-paper-plane-right"></i>` +
      `</button>` +
      (o.after ?? "") +
    `</div>`
  );
}

export interface ComposerFieldWiring {
  core: ComposerCore;
  textarea: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement | null;
  /** Clear the box after a send, keeping highlight/size/button in step. */
  clear(): void;
  /** Re-sync the send button after a host-side value or busy change. */
  sync(): void;
  destroy(): void;
}

export interface WireComposerFieldOpts
  extends Omit<ComposerCoreOptions, "textarea" | "highlightEl" | "onEnter"> {
  /** Called with the trimmed text from Enter (desktop) or the send button. */
  onSend(text: string): void;
  /** Extra gate on sending beyond "box is not blank" (e.g. a busy flag). */
  canSend?: () => boolean;
}

/** Wires a row built by composerFieldHtml. Returns null if the row has no
 *  textarea. The host must call destroy() before dropping or rebuilding it. */
export function wireComposerField(row: HTMLElement, opts: WireComposerFieldOpts): ComposerFieldWiring | null {
  const textarea = row.querySelector<HTMLTextAreaElement>(".composer-textarea");
  if (!textarea) return null;
  const sendBtn = row.querySelector<HTMLButtonElement>(".composer-field-send");
  const { onSend, canSend, onInput, ...coreOpts } = opts;

  const ready = (): boolean => textarea.value.trim() !== "" && (canSend?.() ?? true);
  const sync = (): void => {
    if (sendBtn) sendBtn.disabled = !ready();
  };
  const fire = (): void => {
    if (!ready()) return;
    onSend(textarea.value.trim());
  };

  const core = new ComposerCore({
    ...coreOpts,
    textarea,
    highlightEl: row.querySelector<HTMLElement>(".composer-highlight"),
    onInput: () => {
      sync();
      onInput?.();
    },
    onEnter: fire,
  });
  const onClick = (): void => fire();
  sendBtn?.addEventListener("click", onClick);
  sync();

  return {
    core,
    textarea,
    sendBtn,
    clear: () => {
      textarea.value = "";
      core.autoResize();
      core.updateHighlight();
      sync();
    },
    sync,
    destroy: () => {
      core.destroy();
      sendBtn?.removeEventListener("click", onClick);
    },
  };
}
