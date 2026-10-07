// Ctrl alone shows the sidebar's chat numbers; Ctrl+Shift hides them and shows
// the favourite slots at once, no hold delay (Joe, 2026-10-07: the strip
// animates in instead). Any other key during the hold hides the strip, so
// Ctrl+Shift+Arrow word selection only ever blinks it.

import { describe, it, expect, beforeEach } from "vitest";
import { createModifierHintTracker } from "../src/shared/modifier-hint.ts";

const ev = (key, mods = {}) => ({ key, ctrlKey: false, shiftKey: false, metaKey: false, ...mods });
const CTRL_DOWN = ev("Control", { ctrlKey: true });
const SHIFT_DOWN_WITH_CTRL = ev("Shift", { ctrlKey: true, shiftKey: true });
const SHIFT_UP_WITH_CTRL = ev("Shift", { ctrlKey: true });
const CTRL_UP_WITH_SHIFT = ev("Control", { shiftKey: true });

let hints, tracker;
const last = () => hints[hints.length - 1];

beforeEach(() => {
  hints = [];
  tracker = createModifierHintTracker((h) => hints.push(h));
});

describe("Ctrl alone", () => {
  it("shows the chat numbers and never the favourites", () => {
    tracker.keydown(CTRL_DOWN);
    expect(last()).toEqual({ numbers: true, favorites: false });
  });

  it("hides the numbers on release", () => {
    tracker.keydown(CTRL_DOWN);
    tracker.keyup(ev("Control"));
    expect(last()).toEqual({ numbers: false, favorites: false });
  });
});

describe("Ctrl+Shift hold", () => {
  it("swaps the chat numbers for the favourites on the same keydown, with no delay", () => {
    tracker.keydown(CTRL_DOWN);
    tracker.keydown(SHIFT_DOWN_WITH_CTRL);
    expect(last()).toEqual({ numbers: false, favorites: true });
  });

  it("works with Shift pressed first", () => {
    tracker.keydown(ev("Shift", { shiftKey: true }));
    tracker.keydown(ev("Control", { ctrlKey: true, shiftKey: true }));
    expect(last().favorites).toBe(true);
  });

  it("key repeat emits nothing new", () => {
    tracker.keydown(CTRL_DOWN);
    tracker.keydown(SHIFT_DOWN_WITH_CTRL);
    const count = hints.length;
    tracker.keydown(SHIFT_DOWN_WITH_CTRL);
    expect(hints).toHaveLength(count);
  });

  it("releasing Shift drops back to the chat numbers", () => {
    tracker.keydown(CTRL_DOWN);
    tracker.keydown(SHIFT_DOWN_WITH_CTRL);
    tracker.keyup(SHIFT_UP_WITH_CTRL);
    expect(last()).toEqual({ numbers: true, favorites: false });
  });

  it("releasing Ctrl hides everything", () => {
    tracker.keydown(CTRL_DOWN);
    tracker.keydown(SHIFT_DOWN_WITH_CTRL);
    tracker.keyup(CTRL_UP_WITH_SHIFT);
    expect(last()).toEqual({ numbers: false, favorites: false });
  });
});

describe("another key during the hold", () => {
  it("Ctrl+Shift+Arrow hides the favourites and keeps them hidden for the rest of the hold", () => {
    tracker.keydown(CTRL_DOWN);
    tracker.keydown(SHIFT_DOWN_WITH_CTRL);
    tracker.keydown(ev("ArrowLeft", { ctrlKey: true, shiftKey: true }));
    expect(last()).toEqual({ numbers: false, favorites: false });
    tracker.keydown(SHIFT_DOWN_WITH_CTRL);
    expect(last().favorites).toBe(false);
  });

  it("re-pressing Shift starts a fresh hold", () => {
    tracker.keydown(CTRL_DOWN);
    tracker.keydown(SHIFT_DOWN_WITH_CTRL);
    tracker.keydown(ev("ArrowLeft", { ctrlKey: true, shiftKey: true }));
    tracker.keyup(SHIFT_UP_WITH_CTRL);
    tracker.keydown(SHIFT_DOWN_WITH_CTRL);
    expect(last().favorites).toBe(true);
  });
});

it("window blur clears everything", () => {
  tracker.keydown(CTRL_DOWN);
  tracker.keydown(SHIFT_DOWN_WITH_CTRL);
  tracker.reset();
  expect(last()).toEqual({ numbers: false, favorites: false });
});
