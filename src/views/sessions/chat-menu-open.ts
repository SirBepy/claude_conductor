// Registers what a right-click on any chat avatar or name opens (shared/chat/chat-menu-target.ts
// holds the handler): a sub gets the Subchats card's menu, every other chat the sidebar row's
// menu, both built by chat-menu-items.ts, so no surface draws a menu of its own.

import { setChatMenuOpener } from "../../shared/chat/chat-menu-target";
import { state } from "./state";
import { isMirrored, isSubchat } from "./sessions-helpers";
import { mainChatInfo } from "./main-chat";
import { closeAllMenus } from "./menu-registry";
import { closeCtxMenu, openCtxMenu } from "./sidebar-ctx-menu";
import { closeSubCardMenu, latestSubPreview, openSubCardMenu } from "./chat-dashboard/sub-card-menu";

export function openChatMenuFor(sessionId: string, anchor: HTMLElement): void {
  const sess = state.sessions.find((s) => s.session_id === sessionId);
  // A chat that is gone has no menu; the click still never reaches the browser's own.
  if (!sess) return;
  // No other menu stays up under this one: a right-click draws no click that would dismiss it.
  closeAllMenus();
  closeCtxMenu();
  closeSubCardMenu();
  const main = sess.subchat_of ? state.sessions.find((s) => s.session_id === sess.subchat_of) : undefined;
  const info = main ? mainChatInfo(main, state.sessions).subs.find((s) => s.id === sessionId) : undefined;
  if (!isSubchat(sess) || !main || !info) {
    openCtxMenu(sessionId, anchor);
    return;
  }
  openSubCardMenu({
    subId: sessionId,
    anchor,
    model: sess.model ?? "",
    effort: sess.effort ?? "",
    queued: info.kind === "queued",
    finished: info.kind === "finished",
    busy: sess.busy === true,
    frozen: sess.frozen === true,
    pinned: sess.pinned_to_sidebar === true,
    mirrored: isMirrored(sess),
    open: async () => {
      const pane = document.querySelector<HTMLElement>("#session-pane");
      if (!pane) return;
      const { subchatNavFor } = await import("./active-session");
      await subchatNavFor(pane).open(sessionId);
    },
    latestPreview: async () => (await latestSubPreview(main.session_id, sessionId))?.slug ?? null,
  });
}

setChatMenuOpener(openChatMenuFor);
