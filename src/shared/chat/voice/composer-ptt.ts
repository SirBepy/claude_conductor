// Push-to-talk controller for the Composer, split out of composer.ts (ai_todo
// 232), mirroring how ComposerVoice extracts dictation state. Owns the
// document-level key/mouse listeners for hold-to-record push-to-talk. Bound
// at event time via getPttBinding() so a Settings change takes effect live.
// The binding is suppressed (preventDefault) while held so a printable key
// doesn't also type; mouse handlers run in capture phase to beat webview
// back/forward.

import { getPttBinding, keyMatches, mouseMatches } from "./push-to-talk";
import { voiceDictationEnabled } from "./composer-voice";

export interface ComposerPttCallbacks {
  /** Begin recording at the given caret/insert position. */
  start: (insertPos: number) => void | Promise<void>;
  /** Stop the in-flight recording. */
  stop: () => void | Promise<void>;
  /** Current caret/insert position to start recording from. */
  currentInsertPos: () => number;
  /** True when the composer should ignore key/mouse PTT (phone view - dictates via the on-screen mic instead). */
  isMobile: () => boolean;
  /** True while the composer is disabled (read-only). */
  isDisabled: () => boolean;
}

export class ComposerPtt {
  /** True while the bound key/mouse-button is held down. */
  active = false;

  private cb: ComposerPttCallbacks;

  private _keydown = (e: KeyboardEvent): void => {
    if (this.cb.isDisabled() || this.cb.isMobile() || !voiceDictationEnabled()) return;
    if (!keyMatches(getPttBinding(), e)) return;
    e.preventDefault();
    if (this.active || e.repeat) return;
    this.active = true;
    void this.cb.start(this.cb.currentInsertPos());
  };
  private _keyup = (e: KeyboardEvent): void => {
    if (!this.active || !keyMatches(getPttBinding(), e)) return;
    e.preventDefault();
    this.active = false;
    void this.cb.stop();
  };
  private _mousedown = (e: MouseEvent): void => {
    if (this.cb.isDisabled() || this.cb.isMobile() || !voiceDictationEnabled()) return;
    if (!mouseMatches(getPttBinding(), e)) return;
    e.preventDefault();
    if (this.active) return;
    this.active = true;
    void this.cb.start(this.cb.currentInsertPos());
  };
  private _mouseup = (e: MouseEvent): void => {
    if (!this.active || !mouseMatches(getPttBinding(), e)) return;
    e.preventDefault();
    this.active = false;
    void this.cb.stop();
  };
  // Losing window focus mid-hold would strand the recorder (no keyup arrives).
  private _blur = (): void => {
    if (!this.active) return;
    this.active = false;
    void this.cb.stop();
  };

  constructor(cb: ComposerPttCallbacks) {
    this.cb = cb;
  }

  mount(): void {
    document.addEventListener("keydown", this._keydown);
    document.addEventListener("keyup", this._keyup);
    document.addEventListener("mousedown", this._mousedown, true);
    document.addEventListener("mouseup", this._mouseup, true);
    window.addEventListener("blur", this._blur);
  }

  destroy(): void {
    document.removeEventListener("keydown", this._keydown);
    document.removeEventListener("keyup", this._keyup);
    document.removeEventListener("mousedown", this._mousedown, true);
    document.removeEventListener("mouseup", this._mouseup, true);
    window.removeEventListener("blur", this._blur);
    if (this.active) {
      this.active = false;
      void this.cb.stop();
    }
  }
}
