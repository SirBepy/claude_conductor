import { invoke } from "../../shared/ipc";
import { api } from "../../shared/api";
import { state } from "./state";
import { characterForSession } from "./session-characters";
import { askConfirm } from "../../shared/confirm";

/** True when closing this chat first asks the user to discard a running turn,
 *  so a caller must not start any irreversible close UI before that answer. */
export function closeNeedsConfirm(sessionId: string): boolean {
  return state.sessions.find((s) => s.session_id === sessionId)?.busy === true;
}

/** True when this is a main chat with a sub still running. The daemon holds such
 *  a close and asks on a card (wait for them, close them too, keep it open), so a
 *  caller must not start an irreversible close UI (the row's exit animation, the
 *  character's death cue) before that answer. Finished subs do not count. */
export function closeNeedsApproval(sessionId: string): boolean {
  return state.sessions.some((s) => s.subchat_of === sessionId && !s.subchat_finished && !s.ended_at);
}

async function performClose(sessionId: string): Promise<void> {
  const sess = state.sessions.find((s) => s.session_id === sessionId);
  // Closing cue: play the session character's "death" slot (best-effort;
  // per-slot toggle + mute enforced in the Rust command). Not while the close
  // may be held: the chat is not dying yet.
  if (sess && !closeNeedsApproval(sessionId)) {
    const charId = characterForSession(sess);
    if (charId) void api.playCharacterSlot(charId, "death").catch(() => { /* best-effort */ });
  }
  try {
    // True when the daemon held the close for Joe's answer on the card. The chat
    // is then still open, so nothing below may treat it as closed.
    const held = await invoke<boolean | void>("clear_session", { sessionId });
    if (held === true) return;
    document.dispatchEvent(new CustomEvent("cc:session-closed", { detail: { sessionId } }));
  } catch (err) {
    console.error("[sessions] close chat failed", err);
  }
}

export async function closeChat(sessionId: string): Promise<void> {
  if (closeNeedsConfirm(sessionId)) {
    const ok = await askConfirm("A turn is in progress. Close and discard it?", { confirmLabel: "Discard" });
    if (!ok) return;
    try { await invoke<void>("cancel_turn", { sessionId }); } catch { /* best-effort */ }
  }
  await performClose(sessionId);
}

/** Like closeChat, but always confirms first (not just when a turn is busy) -
 *  used by the ctrl+w shortcut, where closing is the only action, so there's
 *  no surrounding menu click to treat as the user's "yes" already. */
export async function closeChatWithConfirm(sessionId: string): Promise<void> {
  const busy = closeNeedsConfirm(sessionId);
  const ok = await askConfirm(
    busy ? "A turn is in progress. Close and discard it?" : "Close this chat?",
    // The keyboard shortcut that opened this dialog WAS the close intent;
    // focus the confirm button so Enter follows through instead of landing
    // on cancel by default (which just reopens the shortcut's own prompt).
    { confirmLabel: busy ? "Discard" : "Close", focusConfirm: true },
  );
  if (!ok) return;
  if (busy) {
    try { await invoke<void>("cancel_turn", { sessionId }); } catch { /* best-effort */ }
  }
  await performClose(sessionId);
}
