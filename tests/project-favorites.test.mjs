// @vitest-environment jsdom
//
// Slot algebra for the Pick project favourites rail. Joe's requirements,
// 2026-09-26: drag a project in, drag it from one number to another, replace
// one, and drag it off the rail to remove it. Each of those is one function
// here, kept pure so the rules are pinned without rendering the picker.

import { describe, it, expect, beforeEach } from "vitest";
import {
  SLOT_COUNT,
  FAVORITES_STORAGE_KEY,
  emptySlots,
  normalizeSlots,
  readFavorites,
  writeFavorites,
  assignSlot,
  moveSlot,
  clearSlot,
  slotOf,
  pathForKey,
} from "../src/views/sessions/project-favorites.ts";

const A = "C:/Projects/zng-app";
const B = "C:/Projects/countoff";
const C = "C:/Projects/fibo";

beforeEach(() => {
  localStorage.clear();
});

describe("emptySlots / normalizeSlots", () => {
  it("is always exactly 9 entries", () => {
    expect(emptySlots()).toHaveLength(SLOT_COUNT);
    expect(emptySlots().every((s) => s === null)).toBe(true);
  });

  it("coerces junk to empty rather than throwing into the render path", () => {
    expect(normalizeSlots(null)).toEqual(emptySlots());
    expect(normalizeSlots("nope")).toEqual(emptySlots());
    expect(normalizeSlots({ 0: A })).toEqual(emptySlots());
  });

  it("keeps position, drops non-strings, and pads a short array", () => {
    const out = normalizeSlots([A, 42, "", B]);
    expect(out).toHaveLength(SLOT_COUNT);
    expect(out[0]).toBe(A);
    expect(out[1]).toBeNull();
    expect(out[2]).toBeNull();
    expect(out[3]).toBe(B);
  });

  it("drops a duplicate path in a later slot, keeping the first", () => {
    const out = normalizeSlots([A, B, A]);
    expect(out[0]).toBe(A);
    expect(out[1]).toBe(B);
    expect(out[2]).toBeNull();
  });

  it("truncates anything past slot 9", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `C:/p${i}`);
    expect(normalizeSlots(eleven)).toHaveLength(SLOT_COUNT);
  });
});

describe("assignSlot - dragging a project row onto a tile", () => {
  it("places a path in an empty slot", () => {
    const out = assignSlot(emptySlots(), 2, A);
    expect(out[2]).toBe(A);
    expect(slotOf(out, A)).toBe(2);
  });

  it("replaces whatever occupied the target slot", () => {
    const start = assignSlot(emptySlots(), 0, A);
    const out = assignSlot(start, 0, B);
    expect(out[0]).toBe(B);
    expect(slotOf(out, A)).toBe(-1);
  });

  it("vacates the project's previous slot - no project holds two numbers", () => {
    let s = assignSlot(emptySlots(), 0, A);
    s = assignSlot(s, 5, A);
    expect(s[0]).toBeNull();
    expect(s[5]).toBe(A);
    expect(s.filter((p) => p === A)).toHaveLength(1);
  });

  it("never mutates its input", () => {
    const start = emptySlots();
    assignSlot(start, 0, A);
    expect(start[0]).toBeNull();
  });

  it("ignores an out-of-range slot instead of growing the array", () => {
    expect(assignSlot(emptySlots(), 9, A)).toEqual(emptySlots());
    expect(assignSlot(emptySlots(), -1, A)).toEqual(emptySlots());
  });
});

describe("moveSlot - dragging a tile to another number", () => {
  it("moves into an empty target", () => {
    const start = assignSlot(emptySlots(), 0, A);
    const out = moveSlot(start, 0, 4);
    expect(out[0]).toBeNull();
    expect(out[4]).toBe(A);
  });

  it("SWAPS when the target is occupied, so nothing is silently destroyed", () => {
    let s = assignSlot(emptySlots(), 0, A);
    s = assignSlot(s, 1, B);
    const out = moveSlot(s, 0, 1);
    expect(out[0]).toBe(B);
    expect(out[1]).toBe(A);
  });

  it("is a no-op onto itself", () => {
    const start = assignSlot(emptySlots(), 3, A);
    expect(moveSlot(start, 3, 3)).toEqual(start);
  });
});

describe("clearSlot - dragging a tile off the rail", () => {
  it("empties just that slot and leaves the others in place", () => {
    let s = assignSlot(emptySlots(), 0, A);
    s = assignSlot(s, 1, B);
    const out = clearSlot(s, 0);
    expect(out[0]).toBeNull();
    expect(out[1]).toBe(B);
  });

  it("does not shift later slots up - slot 2 stays slot 2", () => {
    let s = assignSlot(emptySlots(), 0, A);
    s = assignSlot(s, 1, B);
    s = assignSlot(s, 2, C);
    const out = clearSlot(s, 1);
    expect(out[2]).toBe(C);
    expect(slotOf(out, C)).toBe(2);
  });
});

describe("pathForKey - what a number key resolves to", () => {
  it("maps key '1' to slot index 0", () => {
    const s = assignSlot(emptySlots(), 0, A);
    expect(pathForKey(s, "1")).toBe(A);
  });

  it("maps key '9' to the last slot", () => {
    const s = assignSlot(emptySlots(), 8, C);
    expect(pathForKey(s, "9")).toBe(C);
  });

  it("returns null for an empty slot, so the key does nothing", () => {
    expect(pathForKey(emptySlots(), "4")).toBeNull();
  });

  it("is inert for '0' and for non-digit keys", () => {
    const s = assignSlot(emptySlots(), 0, A);
    expect(pathForKey(s, "0")).toBeNull();
    expect(pathForKey(s, "a")).toBeNull();
    expect(pathForKey(s, "Enter")).toBeNull();
    expect(pathForKey(s, "")).toBeNull();
  });
});

describe("persistence", () => {
  it("round-trips through localStorage", () => {
    const s = assignSlot(emptySlots(), 2, A);
    writeFavorites(s);
    expect(readFavorites()).toEqual(s);
  });

  it("returns empty slots when nothing was ever stored", () => {
    expect(readFavorites()).toEqual(emptySlots());
  });

  it("survives a corrupt stored value", () => {
    localStorage.setItem(FAVORITES_STORAGE_KEY, "{not json");
    expect(readFavorites()).toEqual(emptySlots());
  });

  it("normalizes a stored value that has drifted out of shape", () => {
    localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify([A, A, 7]));
    const out = readFavorites();
    expect(out).toHaveLength(SLOT_COUNT);
    expect(out[0]).toBe(A);
    expect(out[1]).toBeNull();
  });
});
