// Tells the Android shell which chat is on screen (`ConductorPush.setOnScreenChat`),
// so it skips a "Claude needs your input" banner for the chat already open and
// clears that chat's banner once it is viewed. A chat only counts while the
// Chats view is showing: one left selected under Settings is not on screen.
// The shell itself knows whether the app is in front and unlocked.

interface OnScreenBridgeWindow {
  ConductorPush?: { setOnScreenChat?: (chatId: string) => void };
}

let view: string | null = null;
let chat: string | null = null;
let reported: string | null = null;

/** The router's current view. */
export function noteView(name: string): void {
  view = name;
  report();
}

/** The Chats view's selected chat, or null when none is. */
export function noteSelectedChat(id: string | null): void {
  chat = id;
  report();
}

function report(): void {
  if (typeof window === "undefined") return;
  // Absent on desktop, in a plain phone browser, and in shells older than the bridge method.
  const bridge = (window as unknown as OnScreenBridgeWindow).ConductorPush;
  if (typeof bridge?.setOnScreenChat !== "function") return;
  const next = view === "sessions" && chat ? chat : "";
  if (next === reported) return;
  reported = next;
  try {
    // Called on the bridge object: a detached Java bridge method refuses to run.
    bridge.setOnScreenChat(next);
  } catch (e) {
    console.warn("[on-screen-chat] bridge call failed", e);
  }
}

export function _resetOnScreenChatForTest(): void {
  view = null;
  chat = null;
  reported = null;
}
