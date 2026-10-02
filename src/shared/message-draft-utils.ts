// Draft helpers shared by the two places that render a `DraftVariant`:
// `shared/chat/chat-draft-card.ts` (the inline transcript card) and
// `views/sessions/drafts-editor.ts` / `drafts-panel.ts` (the Drafts panel).
// Lives in `shared/`, not `shared/chat/`, since the panel is not chat - both
// sides may import this, but `shared/` must never import from `views/`.

import type { DraftVariant } from "../types/ipc.generated";

export function currentVersion(variant: DraftVariant) {
  return variant.versions.find((v) => v.n === variant.current) ?? variant.versions[variant.versions.length - 1];
}

export function handleOf(variant: DraftVariant): string {
  return `${variant.recipient} #${variant.handle_n}`;
}

/** Both payloads in one write: Slack and Google Chat read the tags, a plain
 *  field gets the markdown rather than stripped mush. Flips the copy icon to
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
  void navigator.clipboard
    .write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plain], { type: "text/plain" }),
      }),
    ])
    .then(flip)
    .catch(() => void navigator.clipboard.writeText(plain).then(flip));
}
