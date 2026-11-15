// One document-level right-click handler for everything that stands for a chat: an avatar, a
// name, a "from <chat>" label, a link to a chat. A surface marks such an element with
// `data-chat-menu-id="<session id>"` (`chatMenuAttr`) and the handler opens that chat's menu
// through the opener the sessions view registers (views/sessions/chat-menu-open.ts), so a new
// surface needs one attribute and no listener of its own. The sweep that lists every surface
// is tests/chat-menu-targets.test.mjs.
//
// The browser's own menu (Back, Forward, Save as, Print) is never wanted on such an element, so
// it is cancelled even when the chat is gone and there is no menu to open, and on the chat menu
// itself (a second right-click that lands on a menu item used to draw the native menu on top).

import { escapeHtml } from "../escape-html";

export const CHAT_MENU_ATTR = "data-chat-menu-id";

/** The attribute for an HTML string builder, with a leading space: `<span${chatMenuAttr(id)}>`.
 *  Empty when there is no id, so a card about no chat (a plain chat's own question) is not marked. */
export function chatMenuAttr(sessionId: string | null | undefined): string {
  return sessionId ? ` ${CHAT_MENU_ATTR}="${escapeHtml(sessionId)}"` : "";
}

/** For an element built with the DOM API instead of an HTML string. */
export function markChatMenu(el: Element, sessionId: string | null | undefined): void {
  if (sessionId) el.setAttribute(CHAT_MENU_ATTR, sessionId);
}

type Opener = (sessionId: string, anchor: HTMLElement) => void;
let opener: Opener | null = null;

export function setChatMenuOpener(fn: Opener | null): void {
  opener = fn;
}

/** The popups the chat menus draw: the row menu, the sub menu, a nested submenu and the
 *  "more" menu (the Jarvis kebab) that shares the chat menu's items. */
const MENU_POPUPS = ".session-ctx-menu, .chat-menu-submenu, .session-more-menu";

/** Exported for the sweep test; installed on the document below. */
export function onChatContextMenu(e: MouseEvent): void {
  const t = e.target;
  if (!(t instanceof Element)) return;
  // Text fields keep the webview's own copy/paste menu.
  if (t.closest("input, textarea, [contenteditable]")) return;
  if (t.closest(MENU_POPUPS)) {
    e.preventDefault();
    return;
  }
  const el = t.closest<HTMLElement>(`[${CHAT_MENU_ATTR}]`);
  if (!el) return;
  // A surface's own handler (the sidebar row, the Subchats card avatar) already opened its menu.
  const handled = e.defaultPrevented;
  e.preventDefault();
  const id = el.getAttribute(CHAT_MENU_ATTR);
  if (handled || !id) return;
  opener?.(id, el);
}

// The same function reference every time, so a second import never registers a second listener.
// A test that stubs `document` has no addEventListener; the guard keeps every importer loadable there.
if (typeof document !== "undefined" && typeof document.addEventListener === "function") document.addEventListener("contextmenu", onChatContextMenu);
