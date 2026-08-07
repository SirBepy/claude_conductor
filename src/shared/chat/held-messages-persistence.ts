// Cross-reload backstop for the held-messages queue (held-messages.ts), which
// is otherwise pure in-memory JS and used to drop staged-but-unsent messages
// on any full reload. One combined key holds every session's held set so
// sidebar.ts's idle-poll can auto-flush each as its session goes idle.
import type { HeldItem } from "./held-messages";

const LS_KEY = "chat-held:v1";

export function loadAllHeld(): Map<string, HeldItem[]> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return new Map();
    const map = new Map<string, HeldItem[]>();
    for (const [sid, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(val)) continue;
      const items = val.filter(
        (i): i is HeldItem => !!i && typeof i.id === "number" && Array.isArray(i.blocks),
      );
      if (items.length) map.set(sid, items);
    }
    return map;
  } catch {
    return new Map();
  }
}

export function saveAllHeld(map: Map<string, HeldItem[]>): void {
  try {
    const obj: Record<string, HeldItem[]> = {};
    for (const [sid, items] of map) if (items.length) obj[sid] = items;
    if (Object.keys(obj).length === 0) localStorage.removeItem(LS_KEY);
    else localStorage.setItem(LS_KEY, JSON.stringify(obj));
  } catch {
    /* quota or storage disabled - queued messages won't survive a reload, don't crash */
  }
}
