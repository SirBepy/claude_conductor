// Android shell bridge for native (FCM) pushes. The shell exposes
// `window.ConductorPush.getHandle()` (a JSON string `{"handle","secret"}` or ""),
// calls `window.__ccPushHandleReady()` when a handle appears after page load, and
// calls `window.__ccOpenChat(chatId)` when the user taps a notification. The
// daemon needs the handle to send through the relay, so the phone SPA relays it
// over the normal authenticated RPC channel.

import { getTransport, isRemote } from "./transport";

interface ConductorPushBridge {
  getHandle?: () => string;
}

interface PushWindow {
  ConductorPush?: ConductorPushBridge;
  __ccPushHandleReady?: () => void;
  __ccOpenChat?: (chatId: string) => void;
}

export interface NativePushDeps {
  /** Hands the handle to the daemon. */
  register: (handle: string, secret: string) => Promise<unknown>;
  /** Opens a chat by session id in the phone UI. */
  openChat: (chatId: string) => void | Promise<void>;
}

function defaultDeps(): NativePushDeps {
  return {
    register: (handle, secret) => getTransport().call("register_fcm_handle", { handle, secret }),
    openChat: async (chatId) => {
      const { openChatById } = await import("../views/sessions/session-controls");
      openChatById(chatId);
    },
  };
}

/** Parses the bridge's reply; null for "" (no handle yet) or anything malformed. */
function readHandle(win: PushWindow): { handle: string; secret: string } | null {
  let raw = "";
  try {
    raw = win.ConductorPush?.getHandle?.() ?? "";
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { handle?: unknown; secret?: unknown };
    if (typeof parsed.handle !== "string" || typeof parsed.secret !== "string") return null;
    if (!parsed.handle || !parsed.secret) return null;
    return { handle: parsed.handle, secret: parsed.secret };
  } catch {
    return null;
  }
}

/**
 * Wires the Android bridge. Call after the remote token is stored, since the
 * registration is an authenticated RPC. A no-op on desktop and in a plain
 * phone browser (no `ConductorPush`).
 */
export function installNativePush(deps: NativePushDeps = defaultDeps()): void {
  if (!isRemote() || typeof window === "undefined") return;
  const win = window as unknown as PushWindow;
  if (!win.ConductorPush) return;

  const registerNow = (): void => {
    const h = readHandle(win);
    if (!h) return;
    void deps.register(h.handle, h.secret).catch((e) => {
      console.warn("[native-push] register_fcm_handle failed", e);
    });
  };

  win.__ccPushHandleReady = registerNow;
  win.__ccOpenChat = (chatId: string) => {
    if (!chatId) return;
    void Promise.resolve(deps.openChat(chatId)).catch((e) => {
      console.warn("[native-push] open chat failed", e);
    });
  };
  registerNow();
}
