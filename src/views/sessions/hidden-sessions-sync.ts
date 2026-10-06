// Keeps the sidebar's hidden-chats list in step with the daemon's copy
// (sessions/hidden_chats.rs), which the desktop app and the phone share.
// Page-lifetime singleton: started once per window, rebound to the current
// sidebar on every sessions-view mount.

import { invoke } from "../../shared/ipc";
import { getTransport } from "../../shared/transport";
import { loadHiddenSessions, writeHiddenSessionsLocal, setHiddenSessionsPusher } from "./sessions-helpers";
import type { HiddenChatsView as HiddenChats } from "../../types/ipc.generated";

/** Set once this device's pre-sync, local-only hides were merged into the
 *  daemon's list. Without it, every boot would re-add a chat another device
 *  had since unhidden. */
const LS_SYNCED = "cc_hidden_synced";

let rerender: (() => void) | null = null;
let started = false;
// Pushes still in flight. A daemon answer or broadcast landing mid-burst
// predates the local click that came after it; adopting it would flick that
// row back for a moment, so adoption waits and one refetch follows the burst.
let inFlight = 0;

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

function adopt(sessions: string[]): void {
  if (inFlight > 0) return;
  const next = new Set(sessions);
  if (sameSet(next, loadHiddenSessions())) return;
  writeHiddenSessionsLocal(next);
  rerender?.();
}

async function refetch(): Promise<void> {
  try {
    let view = await invoke<HiddenChats>("get_hidden_chats");
    if (localStorage.getItem(LS_SYNCED) !== "1") {
      const daemon = new Set(view.sessions);
      const localOnly = [...loadHiddenSessions()].filter((id) => !daemon.has(id));
      if (localOnly.length) view = await invoke<HiddenChats>("update_hidden_chats", { add: localOnly, remove: [] });
      localStorage.setItem(LS_SYNCED, "1");
    }
    adopt(view.sessions);
  } catch (err) {
    console.warn("[hidden-sessions] fetch failed", err);
  }
}

function push(add: string[], remove: string[]): void {
  inFlight++;
  void invoke<HiddenChats>("update_hidden_chats", { add, remove })
    .catch((err) => console.warn("[hidden-sessions] update failed", err))
    .finally(() => {
      inFlight--;
      if (inFlight === 0) void refetch();
    });
}

export function startHiddenSessionsSync(onChange: () => void): void {
  rerender = onChange;
  if (started) return;
  started = true;
  setHiddenSessionsPusher(push);
  void getTransport().listen<HiddenChats>("hidden-chats-changed", (p) => {
    if (Array.isArray(p?.sessions)) adopt(p.sessions);
  });
  // The notifier can drop frames, and a phone tab sleeps through them.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refetch();
  });
  void refetch();
}
