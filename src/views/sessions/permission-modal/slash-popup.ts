// "/" skill-suggestion popup + highlight backdrop wiring for the AUQ card,
// split out of question-ui.ts (ai_todo 439). Uses the shared composer-core
// (same CaretSuggestPopup + SlashProvider the composer uses, now via
// ComposerCore so the highlight backdrop and auto-resize come along too) -
// not a reimplementation. One SlashProvider for the card's lifetime; one
// ComposerCore per textarea per render(), since its DOM node is a child of
// the render()-rebuilt card and must be explicitly destroyed - DOM removal
// alone doesn't drop the popup's own document-level listener.

import { SlashProvider } from "../../../shared/chat/caret-popup/providers/slash";
import { ComposerCore } from "../../../shared/chat/composer-core/core";
import "../../../shared/chat/caret-popup/popup.css";
import "../../../shared/chat/composer-core/core.css";

export interface AuqSlashPopupController {
  /** Mount the popup + highlight backdrop + auto-resize on a textarea just
   *  created by this render() cycle. Call destroyAll() first if remounting
   *  onto a rebuilt DOM (question-ui.ts's render() always does). */
  attach(ta: HTMLTextAreaElement, highlightEl?: HTMLElement | null): void;
  /** Tear down every core mounted since the last attach()/destroyAll(). */
  destroyAll(): void;
  /** Stop the underlying SlashProvider - call once, on card teardown. */
  stop(): void;
}

export function createAuqSlashPopup(cwd?: string | null): AuqSlashPopupController {
  const slashProvider = new SlashProvider();
  void slashProvider.start(cwd ?? null);
  let cores: ComposerCore[] = [];

  function attach(ta: HTMLTextAreaElement, highlightEl?: HTMLElement | null): void {
    const anchor = ta.closest<HTMLElement>(".prompt-q__other") ?? ta.parentElement;
    if (!anchor) return;
    cores.push(new ComposerCore({
      textarea: ta,
      highlightEl,
      anchor,
      providers: [slashProvider],
      // The card's document-level Escape handler cancels the whole card;
      // an Escape that only closed the popup must not also bubble into it.
      stopPropagationOnPopupConsume: true,
    }));
  }

  function destroyAll(): void {
    cores.forEach((c) => c.destroy());
    cores = [];
  }

  function stop(): void {
    slashProvider.stop();
  }

  return { attach, destroyAll, stop };
}
