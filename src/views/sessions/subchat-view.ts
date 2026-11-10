// Reading a hidden sub in the main chat's window, and the way out of it.
//
// A sub opened in place is the ordinary chat view of a row the sidebar hides: the
// same pane, renderer, composer and statusbar, selected by its own session id.
// Only the header differs (a back arrow and a line saying whose sub it is; "Pin to
// sidemenu" is a chat-menu item, chat-menu-items.ts), and everything that asks "which chat's window is this" goes
// through `windowIdOf`, so the sidebar marks the main chat and the prompt gate
// shows the main chat's cards. Whether a pane is a sub's is read from the
// instance's `subchat_of` each time, never kept as view state, so a reload, the
// phone and a restored selection all land in the right shape on their own.

import { invoke } from "../../shared/ipc";
import { getTransport } from "../../shared/transport";
import { showToast } from "../../shared/toast";
import { openFileRef } from "../../shared/chat/file-refs";
import type { Instance } from "../../types/ipc.generated";
import { tierLabel } from "../../shared/model-name";
import { state, windowIdOf } from "./state";
import { isSubchat, sessionSubtitle } from "./sessions-helpers";
import type { SessionHeader } from "./session-header";
import { SubListButton, subInitials } from "./sub-list";
import { refreshSessions, renderSidebar } from "./sidebar";

/** What the chrome needs from the pane that owns it, so this file never imports
 *  `selectSession` (it imports this file). */
export interface SubchatNav {
  /** Open this chat in the pane. */
  open(sessionId: string): Promise<void>;
  /** Open it again even though it is the selected one (its header must change). */
  reopen(sessionId: string): Promise<void>;
}

let list: SubListButton | null = null;

/** Where the main chat's transcript was scrolled to when a sub was opened over
 *  it. Going back restores it: a retained pane re-pins to the bottom on a
 *  reselect, which is right for a chat switch but not for "back". */
let mainScroll: { mainId: string; top: number; pinned: boolean } | null = null;

/** Within this many px of the bottom counts as pinned (chat-scroll's own limit). */
const PINNED_PX = 64;

function messagesEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>("#session-pane .session-messages");
}

function rememberMainScroll(mainId: string): void {
  const el = messagesEl();
  if (!el || state.selectedId !== mainId) return;
  mainScroll = {
    mainId,
    top: el.scrollTop,
    pinned: el.scrollHeight - el.clientHeight - el.scrollTop <= PINNED_PX,
  };
}

function restoreMainScroll(mainId: string): void {
  const memo = mainScroll;
  mainScroll = null;
  if (!memo || memo.mainId !== mainId || memo.pinned) return;
  const el = messagesEl();
  if (!el) return;
  el.scrollTop = memo.top;
  // The pane's own re-pin runs on a frame after the swap; set it again after that.
  requestAnimationFrame(() => { el.scrollTop = memo.top; });
}

/** "Subchat of Auth refactor, Sonnet high, finished, can continue". The tier is
 *  the sub's current one, so it follows a change made from the model picker. */
export function subMetaText(sub: Instance, main: Instance | undefined): string {
  const parts = [`Subchat of ${main ? sessionSubtitle(main) : "its main chat"}`];
  const tier = tierLabel(sub.model, sub.effort);
  if (tier) parts.push(tier);
  if (sub.closing) parts.push("closing");
  else if (sub.subchat_finished) parts.push("finished, can continue");
  else if (sub.progress?.waiting_for) parts.push(sub.progress.waiting_for);
  return parts.join(", ");
}

function iconButton(className: string, icon: string, label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.innerHTML = `<i class="ph ${icon}"></i>`;
  return b;
}

/** Opens `subId` over the main chat that is on screen. */
function openSub(mainId: string, subId: string, nav: SubchatNav): void {
  rememberMainScroll(mainId);
  void nav.open(subId);
}

/** Leaves a sub's view for its main chat. Closes nothing: the sub keeps running or
 *  stays finished, and the main chat's scroll is where Joe left it. */
export async function backToMain(sub: Instance, nav: Pick<SubchatNav, "open">): Promise<void> {
  const mainId = sub.subchat_of;
  if (!mainId) return;
  await nav.open(mainId);
  restoreMainScroll(mainId);
}

/** Pins `subId` to the sidemenu, or takes the pin off. A pin only adds a sidebar
 *  shortcut: the sub keeps its main chat, its cards and its place in the list
 *  (Joe: "if it was spawned as a subchat, its forever a subchat"), so unlike the
 *  old Move to sidebar nothing about the pane or its parked cards changes. */
export async function setSubPinned(subId: string, pinned: boolean): Promise<void> {
  try {
    await invoke<void>("set_sub_pinned", { sessionId: subId, pinned });
  } catch (err) {
    console.error("[subchats] set_sub_pinned failed", err);
    showToast(`Could not ${pinned ? "pin" : "unpin"} it: ${err}`);
    return;
  }
  await refreshSessions();
  const listEl = document.querySelector<HTMLElement>("#sessions-list");
  if (listEl) renderSidebar(listEl);
  list?.update(state.sessions);
}

/** Dresses the header being built for `sess`: a sub gets its back arrow, "Move to
 *  sidebar" and whose-sub line; any other chat gets the sub count, which stays
 *  hidden until the chat has a sub. Called once per `selectSession`. */
export function decorateSubchatHeader(header: SessionHeader, sess: Instance, nav: SubchatNav): void {
  list?.destroy();
  list = null;
  header.el.dataset.subOf = sess.subchat_of ?? "";

  if (!isSubchat(sess)) {
    list = new SubListButton(
      header.trailSlot,
      sess.session_id,
      {
        open: (subId) => openSub(sess.session_id, subId, nav),
        popOut: (subId) => {
          invoke<void>("detach_window", { sessionId: subId }).catch((err) => {
            console.error("[subchats] detach_window failed", err);
            showToast(`Could not open it in a new window: ${err}`);
          });
        },
      },
      () => state.sessions,
    );
    list.update(state.sessions);
    return;
  }

  const main = state.sessions.find((s) => s.session_id === sess.subchat_of);
  const mainName = main ? sessionSubtitle(main) : "the main chat";
  header.el.classList.add("is-sub-view");
  header.onProjectClick = null;
  header.setMeta(subMetaText(sess, main));
  // The list shows a sub as its initials in a ring; the header's avatar says the same.
  header.setAvatarInitials(subInitials(sessionSubtitle(sess)));

  const back = iconButton("icon-btn sub-back-btn", "ph-arrow-left", `Back to ${mainName}`);
  back.addEventListener("click", () => { void backToMain(sess, nav); });
  header.leadSlot.prepend(back);

  // "Pin to sidemenu" is in the chat menu (chat-menu-items.ts), not a header button:
  // Joe once clicked the old Move to sidebar by accident and it is not a move he makes often.
}

/** Follows an instances update for the chat on screen. "rebuild" means its role
 *  changed under the pane (a sub moved to the sidebar), so the header must be
 *  built again; otherwise the count or the whose-sub line is refreshed in place. */
export function syncSubchatChrome(sess: Instance): "ok" | "rebuild" {
  const header = document.querySelector<HTMLElement>(".session-pane .session-header");
  if (!header) return "ok";
  if ((header.dataset.subOf ?? "") !== (sess.subchat_of ?? "")) return "rebuild";
  if (isSubchat(sess)) {
    const main = state.sessions.find((s) => s.session_id === sess.subchat_of);
    const meta = header.querySelector<HTMLElement>(".meta-proj");
    if (meta) meta.textContent = subMetaText(sess, main);
  } else if (list?.belongsTo(sess.session_id)) {
    // Only the button built for THIS chat: the module keeps one, and a header that was
    // never dressed (a draft promoted in place) must not be fed another chat's count.
    list.update(state.sessions);
  }
  return "ok";
}

/** The main chat to fall back to when the sub on screen is gone (ended, or its
 *  row left the list), so the pane is never an empty state under a chat that
 *  still exists. Read BEFORE the refresh that drops the row. */
export function viewedSubsMainId(): string | null {
  const sub = state.sessions.find((s) => s.session_id === state.selectedId);
  return sub?.subchat_of ?? null;
}

/** Listens for the daemon's "open this" requests from its cards. Only the window
 *  that is showing `display_session_id` acts, so a second window stays still. */
export async function installSubchatRequestListeners(nav: SubchatNav): Promise<() => void> {
  const transport = getTransport();
  const inThisWindow = (displayId: unknown): boolean =>
    typeof displayId === "string" && windowIdOf(state.selectedId) === displayId;
  const offOpen = await transport.listen<{ display_session_id?: string; sub_id?: string }>(
    "subchat-open-requested",
    (p) => {
      if (!p?.sub_id || !inThisWindow(p.display_session_id) || state.selectedId === p.sub_id) return;
      openSub(p.display_session_id!, p.sub_id, nav);
    },
  );
  const offLog = await transport.listen<{ display_session_id?: string; path?: string }>(
    "subchat-log-open-requested",
    (p) => {
      if (!p?.path || !inThisWindow(p.display_session_id)) return;
      openFileRef(p.path);
    },
  );
  return () => {
    offOpen();
    offLog();
  };
}
