// The list a feature line's +N opens (features-html.ts `foldHtml`): the chats it folded, one row each
// with its kind icon, name and state, and a pick opens that chat in the line. An anchored popover
// (shared/chat/anchored-popover.ts), so outside click, Escape and viewport clamping are the app's own.

import { escapeHtml } from "../../../shared/escape-html";
import { chatMenuAttr } from "../../../shared/chat/chat-menu-target";
import { CHAT_KIND_INFO } from "../../../shared/chat/chat-kinds";
import { openAnchoredPopover, type AnchoredPopoverHandle } from "../../../shared/chat/anchored-popover";
import type { ChatState, FeatureChat } from "../../../shared/chat/dashboard/features-model";

const STATE_LABEL: Record<ChatState, string> = { asking: "Asking you", working: "Working", queued: "Queued", idle: "Idle", done: "Done" };

/** "Working 2/4" for a chat on a plan, else the state's word. */
const stateText = (c: FeatureChat): string => (c.state === "working" || c.state === "asking" ? `${STATE_LABEL[c.state]} ${c.item.progress}` : STATE_LABEL[c.state]);

export interface FoldPopupOptions {
  anchor: HTMLElement;
  title: string;
  chats: readonly FeatureChat[];
  /** Focus the first row (true), the row of this chat id (a list redrawn under the keyboard), or nothing. */
  focus: boolean | string;
  /** A row was chosen; the popover is already closed. */
  pick(chatId: string): void;
  /** The popover went away (pick, outside click, Escape). */
  onClose(): void;
}

export function openFoldPopup(o: FoldPopupOptions): AnchoredPopoverHandle {
  const pop = document.createElement("div");
  pop.className = "pf-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", o.title);
  pop.innerHTML = `<div class="pf-pop-h">${escapeHtml(o.title)}</div>` + o.chats.map((c) => {
    const info = CHAT_KIND_INFO[c.kind];
    return `<button type="button" class="pf-pop-row" data-chat="${escapeHtml(c.id)}"${chatMenuAttr(c.id)}><span class="pf-ti" data-st="${c.state}"><i class="ph ph-${info.icon}"></i></span><span class="pf-pop-n">${escapeHtml(c.name)}</span><span class="pf-pop-p" data-st="${c.state}">${escapeHtml(stateText(c))}</span></button>`;
  }).join("");
  document.body.appendChild(pop);
  const handle = openAnchoredPopover({ anchor: o.anchor, el: pop, onClose: () => { pop.remove(); o.onClose(); } });
  pop.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".pf-pop-row");
    if (!row) return;
    handle.close();
    o.pick(row.dataset.chat ?? "");
  });
  pop.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const rows = [...pop.querySelectorAll<HTMLElement>(".pf-pop-row")];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const down = e.key === "ArrowDown";
    rows[at < 0 ? (down ? 0 : rows.length - 1) : (at + (down ? 1 : -1) + rows.length) % rows.length]?.focus();
  });
  handle.reposition();
  if (o.focus) {
    const rows = [...pop.querySelectorAll<HTMLElement>(".pf-pop-row")];
    (rows.find((r) => r.dataset.chat === o.focus) ?? rows[0])?.focus({ preventScroll: true });
  }
  return handle;
}
