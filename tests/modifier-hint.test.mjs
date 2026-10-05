// Ctrl alone shows the sidebar's chat numbers; Ctrl+Shift hides them and,
// after a still hold, shows the favourite slots (Joe, 2026-10-05). The delay
// exists so Ctrl+Shift+Arrow word selection never flashes the strip.

import { describe, it, expect, beforeEach } from "vitest";
import { createModifierHintTracker, FAVORITES_HINT_DELAY_MS } from "../src/shared/modifier-hint.ts";

function fakeTimers() {
  let now = 0;
  let pending = [];
  return {
    timers: {
      set: (fn, ms) => { const h = { fn, at: now + ms }; pending.push(h); return h; },
      clear: (h) => { pending = pending.filter((p) => p !== h); },
    },
    advance(ms) {
      now += ms;
      const due = pending.filter((p) => p.at <= now);
      pending = pending.filter((p) => p.at > now);
      for (const p of due) p.fn();
    },
  };
}

const ev = (key, mods = {}) => ({ key, ctrlKey: false, shiftKey: false, metaKey: false, ...mods });
const CTRL_DOWN = ev("Control", { ctrlKey: true });
const SHIFT_DOWN_WITH_CTRL = ev("Shift", { ctrlKey: true, shiftKey: true });
const SHIFT_UP_WITH_CTRL = ev("Shift", { ctrlKey: true });
const CTRL_UP_WITH_SHIFT = ev("Control", { shiftKey: true });

let clock, hints, tracker;
const last = () => hints[hints.length - 1];

beforeEach(() => {
  clock = fakeTimers();
  hints = [];
  tracker = createModifierHintTracker((h) => hints.push(h), FAVORITES_HINT_DELAY_MS, clock.timers);
});

describe("Ctrl alone", () => {
  it("shows the chat numbers and never the favourites", () => {
    tracker.keydown(CTRL_DOWN);
    clock.advance(1000);
    expect(last()).toEqual({ numbers: true, favorites: false });
  });

  it("hides the numbers on release", () => {
    tracker.keydown(CTRL_DOWN);
    tracker.keyup(ev("Control"));
    expect(last()).toEqual({ numbers: false, favorites: false });
  });
});

describe("Ctrl+Shift hold", () => {
  it("hides the chat numbers at once, shows the favourites only after the delay", () => {
    tracker.keydown(CTRL_DOWN);
    tracker.keydown(SHIFT_DOWN_WITH_CTRL);
    expect(last()).toEqual({ numbers: false, favorites: false });
    clock.advance(FAVORITES_HINT_DELAY_MS - 1);
    expect(last().favorites).toBe(false);
    clock.advance(1);
    expect(last()).toEqual({ numbers: false, favorites: true });
  });

  it("works with Shift pressed first", () => {
    tracker.keydown(ev("Shift", { shiftKey: true }));
    tracker.keydown(ev("Control", { ctrlKey: true, shiftKey: true }));
    clock.advance(FAVORITES_HINT_DELAY_MS);
    expect(last().favorites).toBe(true);
  });

  it("key repeat does not restart the delay", () => {
    tracker.keydown(CTRL_DOWN);
    tracker.keydown(SHIFT_DOWN_WITH_CTRL);
    clock.advance(200);
    tracker.keydown(SHIFT_DOWN_WITH_CTRL);
    clock.advance(100);
    expect(last().favorites).toBe(true);
  });

  it("releasing Shift drops back to the chat numbers", () => {
    tracker.keydown(CTRL_DOWN);
    tracker.keydown(SHIFT_DOWN_WITH_CTRL);
    clock.advance(FAVORITES_HINT_DELAY_MS);
    tracker.keyup(SHIFT_UP_WITH_CTRL);
    expect(last()).toEqual({ numbers: true, favorites: false });
  });

  it("releasing Ctrl hides everything", () => {
    tracker.keydown(CTRL_DOWN);
    tracker.keydown(SHIFT_DOWN_WITH_CTRL);
    clock.advance(FAVORITES_HINT_DELAY_MS);
    tracker.keyup(CTRL_UP_WITH_SHIFT);
    expect(last()).toEqual({ numbers: false, favorites: false });
  });
});

describe("another key during the hold", () => {
  it("Ctrl+Shift+Arrow before the delay never shows the favourites", () => {
    tracker.keydown(CTRL_DOWN);
    tracker.keydown(SHIFT_DOWN_WITH_CTRL);
    tracker.keydown(ev("ArrowLeft", { ctrlKey: true, shiftKey: true }));
    clock.advance(5000);
    expect(hints.some((h) => h.favorites)).toBe(false);
  });

  it("a key after the strip appeared hides it again", () => {
    tracker.keydown(CTRL_DOWN);
    tracker.keydown(SHIFT_DOWN_WITH_CTRL);
    clock.advance(FAVORITES_HINT_DELAY_MS);
    tracker.keydown(ev("3", { ctrlKey: true, shiftKey: true }));
    expect(last().favorites).toBe(false);
  });

  it("re-pressing Shift starts a fresh hold", () => {
    tracker.keydown(CTRL_DOWN);
    tracker.keydown(SHIFT_DOWN_WITH_CTRL);
    tracker.keydown(ev("ArrowLeft", { ctrlKey: true, shiftKey: true }));
    tracker.keyup(SHIFT_UP_WITH_CTRL);
    tracker.keydown(SHIFT_DOWN_WITH_CTRL);
    clock.advance(FAVORITES_HINT_DELAY_MS);
    expect(last().favorites).toBe(true);
  });
});

it("window blur clears everything and cancels a pending show", () => {
  tracker.keydown(CTRL_DOWN);
  tracker.keydown(SHIFT_DOWN_WITH_CTRL);
  tracker.reset();
  clock.advance(5000);
  expect(last()).toEqual({ numbers: false, favorites: false });
});
