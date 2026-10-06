// Chats window cross-window messaging. This same main.ts entry point renders
// the detached Chats window (see main.ts's chats-window-mode branch), which
// has no router of its own. The main window hands it a session to open or a
// new chat to start either as a stashed IPC payload (drained once here on
// boot, for a freshly created window) or as a live Tauri event (for an
// already-open window) - both land in this module and route into the Chats
// window's own Sessions/History views.

import { invoke } from "../shared/ipc";
import { showView } from "../shared/navigation";

/** Shape of the `open_chats_new_chat`/`take_pending_new_chat` IPC payload
 * (Rust's `ipc::window::PendingNewChat`, serde camelCase). Carries the full
 * model/effort modal `SessionConfig` - not just model/effort - so account,
 * auto-accept, and character picks survive the Chats-window "+" round trip
 * (ai_todo 163). */
interface PendingNewChatPayload {
  projectPath?: string;
  projectName?: string;
  model?: string;
  effort?: string;
  accountId?: string | null;
  autoAccept?: boolean;
  characterId?: string | null;
}

/**
 * Surface a session in the chats window. "live" selects the running session in
 * the Sessions view; "history" opens it read-only in the History view. Both
 * route through the same select-on-mount queues the in-window flows use.
 */
async function applyChatOpenRequest(sessionId: string | undefined, mode: string | undefined): Promise<void> {
  if (!sessionId) return;
  if (mode === "history") {
    const { queueHistorySelect } = await import("../views/history/history");
    queueHistorySelect(sessionId);
    showView("history");
  } else {
    const { queueSessionSelect } = await import("../views/sessions/sessions");
    queueSessionSelect(sessionId);
    showView("sessions");
  }
}

async function applyChatNewRequest(payload: PendingNewChatPayload | undefined): Promise<void> {
  if (!payload?.projectPath) return;
  const { queueNewChat } = await import("../views/sessions/sessions");
  queueNewChat(
    { path: payload.projectPath, name: payload.projectName ?? payload.projectPath },
    {
      model: payload.model ?? "",
      effort: payload.effort ?? "",
      accountId: payload.accountId ?? null,
      autoAccept: payload.autoAccept,
      characterId: payload.characterId ?? null,
    },
  );
  showView("sessions");
}

// Chats window: honour "Open in chats" and "new chat" requests from the main
// window. Fresh-created window drains the stashed request on boot; an
// already-open window catches the live event.
export function installChatsWindowMessaging(): void {
  void invoke<[string, string] | null>("take_pending_chat_open").then((p) => {
    if (p) void applyChatOpenRequest(p[0], p[1]);
  }).catch(() => {});
  void invoke<PendingNewChatPayload | null>("take_pending_new_chat").then((p) => {
    if (p) void applyChatNewRequest(p);
  }).catch(() => {});
  const ev = window.__TAURI__?.event;
  if (ev?.listen) {
    void ev.listen<{ sessionId: string; mode: string }>(
      "chats-open-session",
      (e) => void applyChatOpenRequest(e.payload?.sessionId, e.payload?.mode),
    );
    void ev.listen<PendingNewChatPayload>(
      "chats-new-chat",
      (e) => void applyChatNewRequest(e.payload),
    );
  }
}
