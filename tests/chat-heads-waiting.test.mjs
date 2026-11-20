// asserts: src/views/sessions/chat-heads-model.ts
// asserts: src/views/sessions/chat-heads.ts
//
// A chat head's red number is the askers waiting on Joe in that chat's window. Opening a chat takes
// its card out of the parked slots (the card goes on screen) and leaving parks it again, so a count
// read from the slots alone vanished on open and came back on blur. `resolveWaiting` keeps the
// number identical across both states.

import { describe, it, expect } from "vitest";

const { resolveWaiting, WAIT_HOLD_MS, ANON_RECHECK_MS, headMark } = await import("../src/views/sessions/chat-heads-model.ts");

const NOW = 1_000_000;
const never = () => false;
const base = { held: new Map(), open: false, anonymousCardUp: false, settled: never, now: NOW };
const raw = (pairs) => new Map(pairs);

describe("resolveWaiting", () => {
  it("counts the askers the slots and the registry name when the chat is blurred", () => {
    const r = resolveWaiting({ ...base, raw: raw([["sub-a", "q1"], ["main", null]]) });
    expect(r.askers).toEqual(["sub-a", "main"]);
    expect(r.dueAt).toBeNull();
  });

  it("keeps the count when the chat opens and its slot is taken before the card mounts", () => {
    // Blurred render: the card is parked.
    const blurred = resolveWaiting({ ...base, raw: raw([["sub-a", "q1"]]) });
    expect(blurred.askers).toHaveLength(1);
    // Open render, slot already taken, card not on screen yet: the old count read 0 here.
    const opening = resolveWaiting({ ...base, open: true, held: blurred.held, raw: raw([]), now: NOW + 10 });
    expect(opening.askers).toEqual(["sub-a"]);
    expect(opening.dueAt).toBe(NOW + 10 + WAIT_HOLD_MS);
    // The card mounts: the on-screen card is a raw asker again, so the hold is not needed.
    const mounted = resolveWaiting({ ...base, open: true, held: opening.held, raw: raw([["sub-a", "q1"]]), now: NOW + 200 });
    expect(mounted.askers).toEqual(["sub-a"]);
    expect(mounted.dueAt).toBeNull();
  });

  it("reads the same on blur as on open: leaving parks the card again", () => {
    const open = resolveWaiting({ ...base, open: true, raw: raw([["sub-a", "q1"]]) });
    const away = resolveWaiting({ ...base, open: false, held: open.held, raw: raw([["sub-a", "q1"]]), now: NOW + 5000 });
    expect(away.askers).toEqual(open.askers);
  });

  it("lets go once the card never shows: the daemon dropped it", () => {
    const blurred = resolveWaiting({ ...base, raw: raw([["sub-a", "q1"]]) });
    const opening = resolveWaiting({ ...base, open: true, held: blurred.held, raw: raw([]), now: NOW + 10 });
    const later = resolveWaiting({ ...base, open: true, held: opening.held, raw: raw([]), now: NOW + 10 + WAIT_HOLD_MS });
    expect(later.askers).toEqual([]);
    expect(later.held.size).toBe(0);
  });

  it("does not count an asker Joe already answered", () => {
    const blurred = resolveWaiting({ ...base, raw: raw([["sub-a", "q1"]]) });
    const r = resolveWaiting({ ...base, open: true, held: blurred.held, raw: raw([]), settled: (id) => id === "q1" });
    expect(r.askers).toEqual([]);
  });

  it("keeps counting while a permission or secret card nobody can name is up, then lets go", () => {
    const blurred = resolveWaiting({ ...base, raw: raw([["chat", "perm-1"]]), unnamed: new Set(["perm-1"]) });
    const up = resolveWaiting({ ...base, open: true, held: blurred.held, raw: raw([]), anonymousCardUp: true, now: NOW + 60_000 });
    expect(up.askers).toEqual(["chat"]);
    // Nothing announces that card going, so the caller is told to look again soon.
    expect(up.dueAt).toBe(NOW + 60_000 + ANON_RECHECK_MS);
    const gone = resolveWaiting({ ...base, open: true, held: up.held, raw: raw([]), anonymousCardUp: false, now: NOW + 60_100 });
    expect(gone.askers).toEqual([]);
  });

  it("a question asker is not kept alive by an unrelated permission card: only its own short hold applies", () => {
    const blurred = resolveWaiting({ ...base, raw: raw([["sub-a", "q1"]]) });
    const opening = resolveWaiting({ ...base, open: true, held: blurred.held, raw: raw([]), now: NOW + 10 });
    const r = resolveWaiting({ ...base, open: true, held: opening.held, raw: raw([]), anonymousCardUp: true, now: NOW + 60_000 });
    expect(r.askers).toEqual([]);
  });

  it("holds nothing for a chat that is not open", () => {
    const blurred = resolveWaiting({ ...base, raw: raw([["sub-a", "q1"]]) });
    const r = resolveWaiting({ ...base, open: false, held: blurred.held, raw: raw([]), now: NOW + 10 });
    expect(r.askers).toEqual([]);
  });

  it("never holds an asker only the registry named: it is not consumed by opening", () => {
    const blurred = resolveWaiting({ ...base, raw: raw([["chat", null]]) });
    const r = resolveWaiting({ ...base, open: true, held: blurred.held, raw: raw([]), now: NOW + 10 });
    expect(r.askers).toEqual([]);
  });

  it("counts each asker once however many sources name it", () => {
    const r = resolveWaiting({ ...base, raw: raw([["sub-a", "q1"], ["sub-b", "q2"]]) });
    expect(r.askers).toEqual(["sub-a", "sub-b"]);
  });
});

describe("one number per head", () => {
  const base = { waiting: 0, unread: 4, finished: 0, hidden: false, open: false, draft: false };
  it("a waiting card outranks the unread number but keeps the draft pencil", () => {
    expect(headMark({ ...base, waiting: 1, draft: true })).toEqual({ badge: { kind: "red", n: 1 }, draft: true });
    expect(headMark({ ...base, waiting: 1 })).toEqual({ badge: { kind: "red", n: 1 }, draft: false });
    expect(headMark(base)).toEqual({ badge: { kind: "purple", n: 4 }, draft: false });
  });
});
