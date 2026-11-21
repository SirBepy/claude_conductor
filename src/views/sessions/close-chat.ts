import { invoke } from "../../shared/ipc";
import { api } from "../../shared/api";
import { state } from "./state";
import { characterForSession } from "./session-characters";
import { askConfirm } from "../../shared/confirm";
import { showToast } from "../../shared/toast";
import { isPointedMainChat } from "./project-main-chats";
import { sessionSubtitle } from "./sessions-helpers";
import { inPutAwayFamily } from "./put-away";

/** True when closing this chat is a put-away: it is its project's main chat, which the daemon
 *  hides and pauses instead of ending (pc-1806). Nothing is deleted, so the close asks nothing
 *  about a running turn (the daemon waits the turn out) and plays no closing cue. */
export function closeIsPutAway(sessionId: string): boolean {
  const s = state.sessions.find((x) => x.session_id === sessionId);
  return !!s && isPointedMainChat(s, state.sessions);
}

/** The word a close action wears: "Put away" for a project's main chat, else "Close". */
export function closeVerb(sessionId: string | null | undefined): string {
  return sessionId && closeIsPutAway(sessionId) ? "Put away" : "Close";
}

/** True when closing this chat first asks the user to discard a running turn,
 *  so a caller must not start any irreversible close UI before that answer.
 *  A put-away discards nothing: the daemon waits the turn out. */
export function closeNeedsConfirm(sessionId: string): boolean {
  if (closeIsPutAway(sessionId)) return false;
  return state.sessions.find((s) => s.session_id === sessionId)?.busy === true;
}

/** True when this is a main chat with a sub still running. The daemon holds such
 *  a close and asks on a card (wait for them, close them too, keep it open), so a
 *  caller must not start an irreversible close UI (the row's exit animation, the
 *  character's death cue) before that answer. Finished subs do not count. A put-away
 *  is held the same way: the chat does not die. */
export function closeNeedsApproval(sessionId: string): boolean {
  if (closeIsPutAway(sessionId)) return true;
  return state.sessions.some((s) => s.subchat_of === sessionId && !s.subchat_finished && !s.ended_at);
}

/** A chat that is already put away has nothing to close until it is reopened: Ctrl+W on its read-only
 *  pane must not ask to put it away again. Says so instead of staying silent. */
function alreadyPutAway(sessionId: string): boolean {
  const s = state.sessions.find((x) => x.session_id === sessionId);
  if (!s || !inPutAwayFamily(s, state.sessions)) return false;
  showToast("Already put away. It stays out of the way until it is reopened.");
  return true;
}

/** True only when the chat was actually closed: a held close and a failed close
 *  both report false, so a caller can tell whether the old chat is still open. */
async function performClose(sessionId: string): Promise<boolean> {
  const sess = state.sessions.find((s) => s.session_id === sessionId);
  const putAway = closeIsPutAway(sessionId);
  // Closing cue: play the session character's "death" slot (best-effort;
  // per-slot toggle + mute enforced in the Rust command). Not while the close
  // may be held: the chat is not dying yet.
  if (sess && !closeNeedsApproval(sessionId)) {
    const charId = characterForSession(sess);
    if (charId) void api.playCharacterSlot(charId, "death").catch(() => { /* best-effort */ });
  }
  try {
    // True when the daemon held the close for Joe's answer on the card, or put the chat away.
    // The chat is then still open, so nothing below may treat it as closed.
    const held = await invoke<boolean | void>("clear_session", { sessionId });
    if (held === true) {
      if (putAway && sess) showToast(`Putting ${sessionSubtitle(sess)} away. Its subs pause at their next turn end.`);
      return false;
    }
    document.dispatchEvent(new CustomEvent("cc:session-closed", { detail: { sessionId } }));
    return true;
  } catch (err) {
    console.error("[sessions] close chat failed", err);
    return false;
  }
}

/** Resolves true when the chat was closed, false when the user declined the
 *  discard prompt, the daemon held the close (or put the chat away) or the close failed. */
export async function closeChat(sessionId: string): Promise<boolean> {
  if (alreadyPutAway(sessionId)) return false;
  if (closeNeedsConfirm(sessionId)) {
    const ok = await askConfirm("A turn is in progress. Close and discard it?", { confirmLabel: "Discard" });
    if (!ok) return false;
    try { await invoke<void>("cancel_turn", { sessionId }); } catch { /* best-effort */ }
  }
  return performClose(sessionId);
}

/** Like closeChat, but always confirms first (not just when a turn is busy) -
 *  used by the ctrl+w shortcut, where closing is the only action, so there's
 *  no surrounding menu click to treat as the user's "yes" already.
 *  A put-away is the exception: it deletes nothing and a reopen undoes it, so it goes straight through. */
export async function closeChatWithConfirm(sessionId: string): Promise<void> {
  if (alreadyPutAway(sessionId)) return;
  if (closeIsPutAway(sessionId)) {
    await performClose(sessionId);
    return;
  }
  const busy = closeNeedsConfirm(sessionId);
  const ok = await askConfirm(
    busy ? "A turn is in progress. Close and discard it?" : "Close this chat?",
    // The keyboard shortcut that opened this dialog WAS the close intent;
    // focus the confirm button so Enter follows through instead of landing
    // on cancel by default (which just reopens the shortcut's own prompt).
    { confirmLabel: busy ? "Discard" : "Close", focusConfirm: true, danger: true },
  );
  if (!ok) return;
  if (busy) {
    try { await invoke<void>("cancel_turn", { sessionId }); } catch { /* best-effort */ }
  }
  await performClose(sessionId);
}
