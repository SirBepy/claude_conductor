// Voice-volatile highlight rendering for the composer: while recording,
// paints the still-revising dictation tail faintly against the committed
// text, layered over the shared core's known-slash-command syntax
// highlighting. Split out of composer.ts (todo 791).
import { highlightComposerInput } from "./chat-transforms";

export interface ComposerHighlightDeps {
  getText: () => string;
  isRecording: () => boolean;
  getVolatileLen: () => number;
  getCommitPos: () => number;
}

export class ComposerHighlight {
  constructor(private deps: ComposerHighlightDeps) {}

  /** While recording, paint the volatile (still-revising) voice tail faintly so
   * it reads as "live, not yet committed". Committed voice text renders
   * normally. Voice/PTT stay main-composer-only, so this stays here rather
   * than in the shared core. */
  computeHtml(): string {
    const val = this.deps.getText();
    const volatileLen = this.deps.getVolatileLen();
    if (this.deps.isRecording() && volatileLen > 0) {
      const commitPos = this.deps.getCommitPos();
      const a = val.slice(0, commitPos);
      const vol = val.slice(commitPos, commitPos + volatileLen);
      const b = val.slice(commitPos + volatileLen);
      return (
        highlightComposerInput(a) +
        `<span class="voice-volatile">${highlightComposerInput(vol)}</span>` +
        highlightComposerInput(b)
      );
    }
    return highlightComposerInput(val);
  }
}
