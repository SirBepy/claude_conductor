// Per-session, device-local "show raw activity" preference (chat-menu.ts).
// Not synced to the daemon or other devices - a view preference only.

const KEY_PREFIX = "cc-show-raw-chat:";

export function isRawViewEnabled(sessionId: string): boolean {
  return localStorage.getItem(KEY_PREFIX + sessionId) === "1";
}

export function setRawViewEnabled(sessionId: string, on: boolean): void {
  if (on) localStorage.setItem(KEY_PREFIX + sessionId, "1");
  else localStorage.removeItem(KEY_PREFIX + sessionId);
}
