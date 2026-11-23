// Voice dictation state machine for the Composer, split out of composer.ts.
// Owns the VoiceController lifecycle, positional tracking (commitPos/volatileLen),
// and the mic button visual state. Composer delegates all voice concerns here.

import { VoiceController, warmVoiceEngine, cleanDictatedText, type VoiceState } from "./controller";
import { getSettings } from "../../state";

/** How long Send waits for a running rewrite before sending the raw text. */
const REWRITE_SEND_GRACE_MS = 1500;
/** How long after a swap Ctrl+Z still restores the raw dictation. */
const UNDO_WINDOW_MS = 10_000;

/** Off unless the user turned it on in Settings > Voice & dictation. */
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

  /** Where this dictation session's text started (set on start, read again
   *  on stop to know the span to hand the cleanup pass - `commitPos` itself
   *  has moved on by then, advanced by every `onFinal` in between). */
  private dictationStartPos = 0;

  /** Generation of the draft. It advances when the composer is cleared or Send
   *  gives up waiting; a rewrite that started under an older value never swaps
   *  its result in. */
  private gen = 0;
  private pending: Promise<void> | null = null;
  private lastSwap: { start: number; rewritten: string; raw: string; until: number } | null = null;

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

  /** Clicking into the composer is the moment dictation is about to be used,
   *  so a sidecar that idle-shut-down while Joe was away starts loading its
   *  model now instead of on the first key press. Throttled inside `warm()`. */
  private onFocusWarm = (): void => this.warm();

  mount(micBtn: HTMLButtonElement, textarea: HTMLTextAreaElement): void {
    this.textarea?.removeEventListener("keydown", this.onUndoKey, true);
    this.textarea?.removeEventListener("focus", this.onFocusWarm);
    this.micBtn = micBtn;
    this.textarea = textarea;
    // Capture phase: runs before the composer's own key handling, and only
    // takes the event when it actually undoes a rewrite.
    textarea.addEventListener("keydown", this.onUndoKey, true);
    textarea.addEventListener("focus", this.onFocusWarm);
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
      this.startRewrite();
      return;
    }
    this.commitPos = insertPos;
    this.dictationStartPos = insertPos;
    this.volatileLen = 0;
    await c.start();
  }

  /** Push-to-talk press: start recording at the caret. No-op if already live. */
  async startForPtt(insertPos: number): Promise<void> {
    const c = this.ensureController();
    if (c.isRecording) return;
    this.commitPos = insertPos;
    this.dictationStartPos = insertPos;
    this.volatileLen = 0;
    await c.start();
  }

  /** Push-to-talk release: stop if we're recording. The raw words stay on
   *  screen and the rewrite swaps in behind them (see `startRewrite`). */
  async stopForPtt(): Promise<void> {
    if (!this.controller?.isRecording) return;
    await this.controller.stop();
    this.startRewrite();
  }

  /** Kicks off the rewrite of the span this dictation just committed and
   *  returns at once: the raw transcript is already in the composer, so the
   *  user can keep typing while the model works. */
  private startRewrite(): void {
    const job: Promise<void> = this.rewriteDictation().finally(() => {
      if (this.pending === job) this.pending = null;
    });
    this.pending = job;
  }

  /** Rewrites the span this dictation committed (`dictationStartPos` to the
   *  now-settled `commitPos`) in place. Fails open: any error (no account,
   *  offline, timeout, a reply that broke the output contract) leaves the raw
   *  transcript untouched and says so on the mic's tooltip. The swap is dropped
   *  when the composer was cleared or sent meanwhile (`gen`), or when the span
   *  is no longer exactly the raw text, so a late reply never clobbers an edit
   *  or lands in the next draft. */
  private async rewriteDictation(): Promise<void> {
    if (!this.textarea || !this.isUsed) return;
    const gen = this.gen;
    const start = this.dictationStartPos;
    const end = this.commitPos;
    if (end <= start) return;
    const raw = this.textarea.value.slice(start, end);
    if (!raw.trim()) return;
    let cleaned: string;
    try {
      cleaned = await cleanDictatedText(raw);
    } catch (e) {
      console.warn("[voice] rewrite failed, keeping raw transcript", e);
      if (this.micBtn) this.micBtn.title = "Rewrite unavailable, kept the raw dictation";
      return;
    }
    const ta = this.textarea;
    if (!ta || gen !== this.gen || !cleaned || cleaned === raw) return;
    const v = ta.value;
    if (v.slice(start, end) !== raw) return; // edited underneath us - don't touch it
    ta.value = v.slice(0, start) + cleaned + v.slice(end);
    // Positions after the swapped span move by the length change; a dictation
    // already running past it keeps its own place.
    const delta = cleaned.length - raw.length;
    if (this.commitPos >= end) this.commitPos += delta;
    if (this.dictationStartPos >= end) this.dictationStartPos += delta;
    const caret = ta.selectionStart >= end ? ta.selectionStart + delta : ta.selectionStart;
    ta.selectionStart = ta.selectionEnd = caret;
    this.lastSwap = { start, rewritten: cleaned, raw, until: Date.now() + UNDO_WINDOW_MS };
    this.cb.onAfterEdit();
  }

  /** Ctrl+Z shortly after a swap puts the raw dictation back. The composer has
   *  no text undo of its own (dictation writes `value` directly), so this is
   *  the only way back from a rewrite that changed the meaning. Anything else
   *  falls through to the normal Ctrl+Z handling. */
  private onUndoKey = (e: KeyboardEvent): void => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "z") return;
    const swap = this.lastSwap;
    const ta = this.textarea;
    if (!swap || !ta || Date.now() > swap.until) return;
    const end = swap.start + swap.rewritten.length;
    const v = ta.value;
    if (v.slice(swap.start, end) !== swap.rewritten) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    ta.value = v.slice(0, swap.start) + swap.raw + v.slice(end);
    const delta = swap.raw.length - swap.rewritten.length;
    if (this.commitPos >= end) this.commitPos += delta;
    if (this.dictationStartPos >= end) this.dictationStartPos += delta;
    ta.selectionStart = ta.selectionEnd = swap.start + swap.raw.length;
    this.lastSwap = null;
    this.cb.onAfterEdit();
  };

  /** True while a rewrite is still running, so Send knows to wait for it. */
  get rewritePending(): boolean {
    return this.pending !== null;
  }

  /** Waits for the running rewrite, but never longer than `graceMs`: past that
   *  the swap is cancelled and Send goes out with the raw dictation, so a slow
   *  model never holds up a message. */
  async settleRewrite(graceMs = REWRITE_SEND_GRACE_MS): Promise<void> {
    const job = this.pending;
    if (!job) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      job.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), graceMs);
      }),
    ]);
    clearTimeout(timer);
    if (timedOut) this.gen++;
  }

  /** Send pressed: stop a live dictation cleanly and await the sidecar's
   *  trailing flush (`controller.stop()`'s own ~300ms wait) before the caller
   *  reads the textarea, so words spoken in the instant before the click land
   *  in the sent text instead of arriving after send has already read it and
   *  leaking into the composer on the next `onFinal`. Then gives a running
   *  rewrite up to `REWRITE_SEND_GRACE_MS` to land. Unlike `reset()`, this
   *  never zeroes commitPos/volatileLen itself; the normal
   *  onFinal/onStateChange path already does that once the flush lands. */
  async finishForSend(): Promise<void> {
    await this.stopForPtt();
    await this.settleRewrite();
  }

  reset(): void {
    this.isUsed = false;
    this.commitPos = 0;
    this.volatileLen = 0;
    // Invalidates any rewrite still in flight: it was for the draft being
    // cleared and must not land in the next one.
    this.gen++;
    this.pending = null;
    this.lastSwap = null;
    if (this.controller?.isRecording) void this.controller.stop();
  }

  destroy(): void {
    this.textarea?.removeEventListener("keydown", this.onUndoKey, true);
    this.textarea?.removeEventListener("focus", this.onFocusWarm);
    void this.controller?.destroy();
    this.controller = null;
  }

  private stateListeners = new Set<(state: VoiceState) => void>();

  /** Notified on every state flip, in addition to the mic button + highlight
   *  updates `onStateChange` already drives. Exists for a surface that isn't
   *  the composer itself - the lightbox's full-screen overlay (z-index 9999)
   *  covers the mic button, so dictation looks stopped while previewing an
   *  attachment even though it never paused; the lightbox subscribes here to
   *  show its own indicator. Returns an unsubscribe function. */
  subscribe(cb: (state: VoiceState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  applyState(): void {
    if (!this.micBtn) return;
    this.micBtn.classList.toggle("recording", this.state === "recording");
    this.micBtn.classList.toggle("connecting", this.state === "connecting");
  }

  private onStateChange(s: VoiceState): void {
    this.state = s;
    this.stateListeners.forEach((cb) => cb(s));
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
