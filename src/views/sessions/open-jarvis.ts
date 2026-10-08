// The sidemenu's Jarvis entry. Desktop opens the dedicated Jarvis
// window; the phone has no windows, so it get-or-spawns the same singleton and
// opens it in its own single-pane Chats view, where the chat list still hides
// the row (`isJarvisOrWorker`) just like desktop's sidebar does.

import { invoke } from "../../shared/ipc";
import { isRemote } from "../../shared/transport";
import { showView } from "../../shared/navigation";
import { showToast } from "../../shared/toast";
import { queueSessionSelect } from "./session-controls";

export async function openJarvis(): Promise<void> {
  if (!isRemote()) {
    // open_jarvis_window surfaces its own failure as a native dialog.
    if (window.__TAURI__) await invoke("open_jarvis_window");
    return;
  }
  let sessionId: string;
  try {
    ({ session_id: sessionId } = await invoke<{ session_id: string }>("ensure_jarvis_session"));
  } catch (err) {
    // Most commonly NoDefault (no default account with 2+ registered) - a
    // silent failure here would read as a dead button.
    showToast(`Couldn't open Jarvis: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
  queueSessionSelect(sessionId);
  showView("sessions");
}
