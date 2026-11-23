// Which finished line is open and which of its chats shows its steps, and how a click changes that.
// Shared by the Done card and its popup. The choice is patched onto the drawn DOM in place
// (`applyOpen`), so opening a line or a chat is a class change the CSS transitions run on, not a redraw.

import type { DoneOpen } from "./done-lines-html";

/** One line is open at a time; a chat's steps open under its row, one chat at a time. */
export function nextOpen(open: DoneOpen, act: string, feat: string, chat: string): DoneOpen {
  if (act === "dl-open") return open.feat === feat ? { feat: null, chat: null } : { feat, chat: null };
  if (act === "dl-chat") return { feat, chat: open.feat === feat && open.chat === chat ? null : chat };
  return open;
}

/** Writes `open` onto every line under `root`: the class the transitions run on, `aria-expanded`, and
 *  `inert` on what is folded away, so a hidden chat row or step is never a tab stop. */
export function applyOpen(root: HTMLElement, open: DoneOpen): void {
  for (const line of root.querySelectorAll<HTMLElement>(".dl-feat")) {
    const on = line.dataset.feat === open.feat;
    line.classList.toggle("is-open", on);
    line.querySelector(".pf-row")?.setAttribute("aria-expanded", String(on));
    line.querySelector(".dl-det")?.toggleAttribute("inert", !on);
    for (const wrap of line.querySelectorAll<HTMLElement>(".dl-chatwrap")) {
      const chatOn = on && wrap.dataset.chatWrap === open.chat;
      wrap.classList.toggle("is-open", chatOn);
      wrap.querySelector(".dl-chat")?.setAttribute("aria-expanded", String(chatOn));
      wrap.querySelector(".dl-cview")?.toggleAttribute("inert", !chatOn);
    }
  }
}
