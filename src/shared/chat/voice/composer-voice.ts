// Voice dictation state machine for the Composer, split out of composer.ts.
// Owns the VoiceController lifecycle, positional tracking (commitPos/volatileLen),
// and the mic button visual state. Composer delegates all voice concerns here.

import { VoiceController, warmVoiceEngine, type VoiceState } from "./controller";
import { getSettings } from "../../state";

/** Off unless the user turned it on in Settings > Notifications > Audio. */
export function voiceDictationEnabled(): boolean {
  return getSettings().voiceDictationEnabled === true;
}

export interface ComposerVoiceCallbacks {
  /** Full edit: autoResize + updateHighlight + persistDraft + onDraftActivity. */
  onAfterEdit: () => void;
  /** State-change only: updateHighlight (no resize/persist needed). */
  onHighlightOnly: () => void;
}

export class ComposerVoice {
  state: VoiceState = "idle";
  commitPos = 0;
  volatileLen = 0;
  isUsed = false;

  private controller: VoiceController | null = null;
  private micBtn: HTMLButtonElement | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private cb: ComposerVoiceCallbacks;
  private lastWarmAt = 0;

  constructor(cb: ComposerVoiceCallbacks) {
    this.cb = cb;
  }

  /** Pre-warm the STT sidecar so the first mic click starts recording instantly.
   *  Called when the chat opens (and on mic hover as a re-warm). Throttled: the
   *  daemon idle-shuts the sidecar down after a few idle minutes, so re-warm only
   *  when the last warm is stale enough to have plausibly expired. */
  warm(): void {
    if (!voiceDictationEnabled()) return;
    const now = Date.now();
    if (now - this.lastWarmAt < 4 * 60_000) return;
    this.lastWarmAt = now;
    void warmVoiceEngine();
  }

  mount(micBtn: HTMLButtonElement, textarea: HTMLTextAreaElement): void {
    this.micBtn = micBtn;
    this.textarea = textarea;
    this.applyState();
  }

  private ensureController(): VoiceController {
    if (!this.controller) {
      this.controller = new VoiceController({
        onPartial: (t) => this.onPartial(t),
        onFinal: (t) => this.onFinal(t),
        onError: (m) => this.onError(m),
        onStateChange: (s) => this.onStateChange(s),
      });
    }
    return this.controller;
  }

  async toggle(insertPos: number): Promise<void> {
    const c = this.ensureController();
    if (c.isRecording) {
      await c.stop();
      return;
    }
    this.commitPos = insertPos;
    this.volatileLen = 0;
    await c.start();
  }

  /** Push-to-talk press: start recording at the caret. No-op if already live. */
  async startForPtt(insertPos: number): Promise<void> {
    const c = this.ensureController();
    if (c.isRecording) return;
    this.commitPos = insertPos;
    this.volatileLen = 0;
    await c.start();
  }

  /** Push-to-talk release: stop if we're recording. */
  async stopForPtt(): Promise<void> {
    if (this.controller?.isRecording) await this.controller.stop();
  }

  reset(): void {
    this.isUsed = false;
    this.commitPos = 0;
    this.volatileLen = 0;
    if (this.controller?.isRecording) void this.controller.stop();
  }

  destroy(): void {
    void this.controller?.destroy();
    this.controller = null;
  }

  applyState(): void {
    if (!this.micBtn) return;
    this.micBtn.classList.toggle("recording", this.state === "recording");
    this.micBtn.classList.toggle("connecting", this.state === "connecting");
  }

  private onStateChange(s: VoiceState): void {
    this.state = s;
    if ((s === "idle" || s === "error") && this.volatileLen > 0 && this.textarea) {
      const v = this.textarea.value;
      this.textarea.value =
        v.slice(0, this.commitPos) + v.slice(this.commitPos + this.volatileLen);
      this.volatileLen = 0;
    }
    this.applyState();
    this.cb.onHighlightOnly();
  }

  private onPartial(text: string): void {
    if (!this.textarea) return;
    const v = this.textarea.value;
    this.textarea.value =
      v.slice(0, this.commitPos) + text + v.slice(this.commitPos + this.volatileLen);
    this.volatileLen = text.length;
    this.textarea.selectionStart = this.textarea.selectionEnd = this.commitPos + this.volatileLen;
    this.isUsed = true;
    this.cb.onAfterEdit();
    this.revealCaret();
  }

  private onFinal(text: string): void {
    if (!this.textarea || !text) return;
    const v = this.textarea.value;
    const before = v.slice(0, this.commitPos);
    const after = v.slice(this.commitPos + this.volatileLen);
    this.textarea.value = before + text + after;
    this.commitPos += text.length;
    this.volatileLen = 0;
    this.textarea.selectionStart = this.textarea.selectionEnd = this.commitPos;
    this.isUsed = true;
    this.cb.onAfterEdit();
    this.revealCaret();
  }

  /** A programmatic value write never scrolls a textarea to its caret (only
   *  typing does), so dictation past the composer's max height ran on out of
   *  sight. Measures the caret's bottom edge by briefly truncating the value
   *  to the text before it - no layout is painted in between. */
  private revealCaret(): void {
    const ta = this.textarea;
    if (!ta) return;
    const caret = this.commitPos + this.volatileLen;
    const full = ta.value;
    const prevTop = ta.scrollTop;
    ta.value = full.slice(0, caret);
    const caretBottom = ta.scrollHeight;
    ta.value = full;
    ta.selectionStart = ta.selectionEnd = caret;
    ta.scrollTop = prevTop;
    if (caretBottom > ta.scrollTop + ta.clientHeight) ta.scrollTop = caretBottom - ta.clientHeight;
  }

  private onError(message: string): void {
    console.warn("[voice]", message);
    if (this.micBtn) this.micBtn.title = `Voice error: ${message}`;
  }
}
