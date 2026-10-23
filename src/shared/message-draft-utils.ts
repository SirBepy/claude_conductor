// Draft helpers shared by the two places that render a `DraftVariant`:
// `shared/chat/chat-draft-card.ts` (the inline transcript card) and
// `views/sessions/drafts-editor.ts` / `drafts-panel.ts` (the Drafts panel).
// Lives in `shared/`, not `shared/chat/`, since the panel is not chat - both
// sides may import this, but `shared/` must never import from `views/`.

import type { DraftVariant } from "../types/ipc.generated";
import { isMobileViewport } from "./mobile-viewport";

export function currentVersion(variant: DraftVariant) {
  return variant.versions.find((v) => v.n === variant.current) ?? variant.versions[variant.versions.length - 1];
}

export function handleOf(variant: DraftVariant): string {
  return `${variant.recipient} #${variant.handle_n}`;
}

/** Markdown rewritten into what Slack's composer shows cleanly when it only
 *  gets plain text: Slack never parses `[text](url)` or `**bold**`, so the
 *  link becomes `text (url)` (the bare URL auto-links) and bold uses Slack's
 *  own single-asterisk form. */
export function slackPlainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text: string, url: string) =>
      text === url ? url : `${text} (${url})`)
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*");
}

/** Both payloads in one write: Slack and Google Chat read the tags, a plain
 *  field gets the markdown rather than stripped mush. On the phone, and on
 *  the plain-text-only fallback, the plain half is `slackPlainText` instead:
 *  Slack mobile pastes the plain half, and the fallback's plain text is all a
 *  rich field receives. Flips the copy icon to
 *  a check and reverts it after 1500ms, then runs the caller's own
 *  post-copy call (a `set_draft_state` invoke, or an editor's `setState`).
 *  Callers derive `plain` themselves - the card hands over its store copy,
 *  the editor re-serializes the contenteditable DOM - since that is the one
 *  real difference between the two copy actions. */
export function copyDualPayload(html: string, plain: string, btn: HTMLElement, onDone: () => void): void {
  const flip = (): void => {
    const icon = btn.querySelector("i");
    if (icon) icon.className = "ph ph-check";
    setTimeout(() => {
      const back = btn.querySelector("i");
      if (back) back.className = "ph ph-copy";
    }, 1500);
    onDone();
  };
  const slackPlain = slackPlainText(plain);
  const plainHalf = isMobileViewport() ? slackPlain : plain;
  // ClipboardItem is missing in some webviews; that throws synchronously,
  // so it is built inside the promise chain to reach the same fallback.
  void Promise.resolve()
    .then(() => navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plainHalf], { type: "text/plain" }),
      }),
    ]))
    .then(flip)
    .catch(() => void navigator.clipboard.writeText(slackPlain).then(flip));
}
