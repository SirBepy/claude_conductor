// Reopening a put-away main chat (pc-1806 step 6): the three doors (the draft's first send, the
// project dashboard's "Open main chat", the Reopen button on the read-only banner) share this one
// path, so the daemon is asked the same way and the chat opens the same way.
//
// The daemon's `reopen_main_chat` opens the gate and leaves the paused subs paused; the
// "Continue the plan?" part (continue-plan.ts) then asks what to do with them. Nothing here
// resumes anything.

import { invoke } from "../../shared/ipc";
import { showToast } from "../../shared/toast";
import { state, setActiveSession } from "./state";
import type { PausedFamily } from "./continue-plan-model";
import { withPutAway } from "./put-away";

/** Opens the gate on a put-away main chat. Null when the daemon refused (a put-away still
 *  running, a chat that is not put away): the reason is toasted, and nothing was changed. */
export async function reopenMainChat(mainId: string): Promise<PausedFamily | null> {
  try {
    const r = await invoke<{ state: PausedFamily }>("reopen_main_chat", { sessionId: mainId });
    return r.state;
  } catch (err) {
    console.error("[sessions] reopen_main_chat failed", err);
    showToast(`Could not reopen the main chat: ${String(err)}`);
    return null;
  }
}

/** What is still paused under `mainId`: the daemon's record, so a restart or a "Not now" cannot lose it. */
export async function readPaused(mainId: string): Promise<PausedFamily | null> {
  try {
    return await invoke<PausedFamily>("put_away_paused", { sessionId: mainId }, { background: true });
  } catch (err) {
    console.warn("[sessions] put_away_paused failed", err);
    return null;
  }
}

/** Reopens the chat when it is put away; true when it is open now (it already was, or the reopen
 *  worked). The list is re-read after a reopen so the pane is built from the reopened row, not
 *  the read-only one it replaces. */
export async function reopenIfPutAway(mainId: string): Promise<boolean> {
  // A put-away chat is not in the listing (it is closed everywhere): the reopen doors read it from `putAway`.
  const row = withPutAway(state.sessions, state.putAway).find((s) => s.session_id === mainId);
  if (!row?.hidden_at) return true;
  if (!(await reopenMainChat(mainId))) return false;
  const { refreshSessions } = await import("./sidebar");
  await refreshSessions();
  return true;
}

/** Reopens (when it is put away) and shows the main chat. */
export async function openMainChat(mainId: string, pane: HTMLElement): Promise<boolean> {
  if (!(await reopenIfPutAway(mainId))) return false;
  // The chat already on screen (the banner's button) is built read-only: the instances update
  // that follows a reopen rebuilds it too, and this does not wait for that frame.
  const open = state.sessions.find((s) => s.session_id === mainId);
  if (open && state.selectedId === mainId) {
    const { syncSubchatChrome } = await import("./subchat-view");
    if (syncSubchatChrome(open) === "rebuild") setActiveSession(null);
  }
  const { selectSession } = await import("./active-session");
  await selectSession(mainId, pane);
  return true;
}
