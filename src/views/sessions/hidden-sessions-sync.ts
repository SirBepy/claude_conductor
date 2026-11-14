// Keeps the sidebar's hidden-chats list in step with
// the daemon's copy (sessions/hidden_chats.rs), which the desktop app and the
// phone share. Page-lifetime singleton: started once per window, rebound to
// the current sidebar on every sessions-view mount.

import { invoke } from "../../shared/ipc";
import { getTransport } from "../../shared/transport";
import {
  loadHiddenSessions,
  writeHiddenSessionsLocal,
  setHiddenSessionsPusher,
  type HiddenDelta,
} from "./sessions-helpers";
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

function adopt(view: HiddenChats): void {
  if (inFlight > 0) return;
  const sessions = new Set(view.sessions);
  if (sameSet(sessions, loadHiddenSessions())) return;
  writeHiddenSessionsLocal(sessions);
  rerender?.();
}

function localOnly(local: Set<string>, daemon: string[] | undefined): string[] {
  const known = new Set(daemon ?? []);
  return [...local].filter((id) => !known.has(id));
}

function update(delta: HiddenDelta): Promise<HiddenChats> {
  return invoke<HiddenChats>("update_hidden_chats", {
    add: delta.add ?? [],
    remove: delta.remove ?? [],
  });
}

async function refetch(): Promise<void> {
  try {
    let view = await invoke<HiddenChats>("get_hidden_chats");
    if (localStorage.getItem(LS_SYNCED) !== "1") {
      const add = localOnly(loadHiddenSessions(), view.sessions);
      if (add.length) view = await update({ add });
      localStorage.setItem(LS_SYNCED, "1");
    }
    adopt(view);
  } catch (err) {
    console.warn("[hidden-sessions] fetch failed", err);
  }
}

function push(delta: HiddenDelta): void {
  inFlight++;
  void update(delta)
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
    if (Array.isArray(p?.sessions)) adopt(p);
  });
  // The notifier can drop frames, and a phone tab sleeps through them.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refetch();
  });
  void refetch();
}
