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

export async function closeChat(sessionId: string): Promise<void> {
  const sess = state.sessions.find((s) => s.session_id === sessionId);
  if (closeNeedsConfirm(sessionId)) {
    const ok = await askConfirm("A turn is in progress. Close and discard it?", { confirmLabel: "Discard" });
    if (!ok) return;
    try { await invoke<void>("cancel_turn", { sessionId }); } catch { /* best-effort */ }
  }
  // Closing cue: play the session character's "death" slot (best-effort;
  // per-slot toggle + mute enforced in the Rust command).
  if (sess) {
    const charId = characterForSession(sess);
    if (charId) void api.playCharacterSlot(charId, "death").catch(() => { /* best-effort */ });
  }
  try {
    await invoke<void>("clear_session", { sessionId });
    document.dispatchEvent(new CustomEvent("cc:session-closed", { detail: { sessionId } }));
  } catch (err) {
    console.error("[sessions] close chat failed", err);
  }
}
