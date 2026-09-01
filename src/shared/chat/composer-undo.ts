// Ctrl+Z / Ctrl+Enter undo-queue chain for the composer: repeated Ctrl+Z
// walks back through the held queue then the sent-outbox, and Ctrl+Enter on
// an empty draft with a queued held set sends it immediately. Split out of
// composer.ts (todo 791).
import type { ContentBlock } from "../../types/ipc.generated";
import { blocksToText } from "./content-blocks";
import { popLastSent } from "./sent-outbox";
import type { Attachment, PastedBlock } from "./composer-attachments";

export interface ComposerUndoDeps {
  getTextarea: () => HTMLTextAreaElement | null;
  getAttachments: () => Attachment[];
  getPastedBlocks: () => PastedBlock[];
  isVoiceUsed: () => boolean;
  isDraftEmpty: () => boolean;
  getSessionId: () => string | null;
  setDraftText: (text: string) => void;
  send: () => Promise<void> | void;
  hasHeld?: () => boolean;
  popLastHeld?: () => ContentBlock[] | null;
  sendQueuedNow?: () => Promise<void> | void;
}

export class ComposerUndo {
  // True mid Ctrl+Z chain - lets repeated presses keep walking the queue.
  private undoChainActive = false;

  constructor(private deps: ComposerUndoDeps) {}

  /** Cursor/selection start, or end-of-text when nothing is selected. */
  currentInsertPos(): number {
    const ta = this.deps.getTextarea();
    return ta?.selectionStart ?? ta?.value.length ?? 0;
  }

  /** A fresh keystroke or an explicit setDraftText breaks the undo chain. */
  resetChain(): void {
    this.undoChainActive = false;
  }

  /** Ctrl/Cmd+Enter with an empty draft and a queued (held) set sends the
   *  queue immediately, busy or not - the same action as the chip's "Send
   *  now". Any other case (draft has content, or nothing queued) falls
   *  through to the normal send() path unchanged. */
  handleCtrlEnter(): void {
    if (this.deps.isDraftEmpty() && this.deps.hasHeld?.()) {
      void this.deps.sendQueuedNow?.();
      return;
    }
    void this.deps.send();
  }

  /** Ctrl/Cmd+Z: pop the last queued message back into the draft, then the
   *  sent-outbox. Both empty declines, handing back to native text-undo. */
  handleUndoQueued(): boolean {
    if (!this.deps.isDraftEmpty() && !this.undoChainActive) return false;
    const blocks = this.deps.popLastHeld?.();
    const sessionId = this.deps.getSessionId();
    const popped = blocks ? blocksToText(blocks) : (sessionId ? popLastSent(sessionId) : null);
    if (popped === null) return false;
    const rest = this.undoChainActive ? (this.deps.getTextarea()?.value ?? "") : "";
    this.deps.setDraftText(rest ? `${popped}\n\n${rest}` : popped);
    this.undoChainActive = true;
    return true;
  }

  /** Build the ContentBlock[] for the current draft: typed text + any held
   * pasted-log sentinels + attachment <file:…> mentions. Pure (no clear). The
   * <pasted-log> wrapper is collapsed into a chip by the chat renderer so the
   * user never sees the wall of text in their own message. */
  buildBlocks(text: string): ContentBlock[] {
    let fullText = text;
    for (const b of this.deps.getPastedBlocks()) {
      const nonce = Math.random().toString(36).slice(2, 10);
      const wrapped = `<pasted-log id="${nonce}" name="${b.name}">\n${b.text}\n</pasted-log:${nonce}>`;
      fullText += (fullText ? "\n\n" : "") + wrapped;
    }
    // Mark voice-dictated messages so the model reads them charitably (homophones,
    // transcription noise); the renderer collapses this into a mic chip.
    if (this.deps.isVoiceUsed()) {
      fullText += (fullText ? "\n" : "") + "<voice-input/>";
    }
    const blocks: ContentBlock[] = [];
    if (fullText) blocks.push({ type: "text", text: fullText });
    for (const a of this.deps.getAttachments()) {
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
}
