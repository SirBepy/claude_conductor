// @vitest-environment jsdom
// asserts: src/views/sessions/chat-heads-keys.ts
// Holding Ctrl alone ~0.4s opens the stack and numbers the heads; while held Up/Down walk a
// looping highlight; releasing Ctrl opens the highlighted chat; Esc cancels.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHeadKeys, HOLD_MS } from "../src/views/sessions/chat-heads-keys.ts";

let ui, renders, opened, count, keys;

beforeEach(() => {
  vi.useFakeTimers();
  ui = { open: true, numbers: false, highlight: -1 };
  renders = 0;
  opened = [];
  count = 4;
  keys = createHeadKeys({ ui, count: () => count, render: () => { renders++; }, openIndex: (i) => opened.push(i) });
});
afterEach(() => { keys.dispose(); vi.useRealTimers(); });

const down = (key) => ({ key, ctrlKey: true, shiftKey: false });

describe("holding Ctrl", () => {
  it("shows no numbers before the hold is long enough", () => {
    keys.hint(true);
    vi.advanceTimersByTime(HOLD_MS - 1);
    expect(ui.numbers).toBe(false);
    keys.hint(false);
    expect(renders).toBe(0);
  });

  it("numbers the heads once the hold passes the delay, and removes them on release", () => {
    keys.hint(true);
    vi.advanceTimersByTime(HOLD_MS);
    expect(ui.numbers).toBe(true);
    keys.hint(false);
    expect(ui.numbers).toBe(false);
    expect(opened).toEqual([]);
  });

  it("opens a closed stack for the hold and closes it again on release", () => {
    ui.open = false;
    keys.hint(true);
    vi.advanceTimersByTime(HOLD_MS);
    expect(ui.open).toBe(true);
    keys.hint(false);
    expect(ui.open).toBe(false);
  });

  it("leaves a stack Joe opened open", () => {
    keys.hint(true);
    vi.advanceTimersByTime(HOLD_MS);
    keys.hint(false);
    expect(ui.open).toBe(true);
  });
});

describe("a hold that ends some other way than a plain Ctrl release", () => {
  const walkThenEnd = (end) => {
    keys.hint(true);
    keys.keydown(down("ArrowDown"));
    expect(ui.highlight).toBe(0);
    end();
    keys.hint(false);
  };

  it("opens nothing when Shift (the favourites combo) joins the hold", () => {
    walkThenEnd(() => keys.keydown({ key: "Shift", ctrlKey: true, shiftKey: true }));
    expect(opened).toEqual([]);
  });

  it("opens nothing when a Ctrl+digit shortcut already opened its own chat", () => {
    walkThenEnd(() => keys.keydown(down("3")));
    expect(opened).toEqual([]);
  });

  it("opens nothing when the window loses focus mid-hold, even though shortcuts.ts resets the hint on that same blur first", () => {
    // shortcuts.ts registers its blur listener at module init, before any view mounts, and its
    // reset calls hint(false). Registered here before the keys exist, to keep that order.
    let k;
    const earlier = () => k.hint(false);
    window.addEventListener("blur", earlier);
    k = createHeadKeys({ ui, count: () => count, render: () => { renders++; }, openIndex: (i) => opened.push(i) });
    k.hint(true);
    k.keydown(down("ArrowDown"));
    expect(ui.highlight).toBe(0);
    window.dispatchEvent(new Event("blur"));
    expect(opened).toEqual([]);
    window.removeEventListener("blur", earlier);
    k.dispose();
  });

  it("keeps the pick when only an element inside the page loses focus", () => {
    keys.hint(true);
    keys.keydown(down("ArrowDown"));
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.dispatchEvent(new FocusEvent("blur"));
    keys.hint(false);
    expect(opened).toEqual([0]);
    input.remove();
  });

  it("closes a stack the hold opened when the view goes away mid-hold", () => {
    ui.open = false;
    keys.hint(true);
    vi.advanceTimersByTime(HOLD_MS);
    expect(ui.open).toBe(true);
    keys.dispose();
    expect(ui.open).toBe(false);
  });
});

describe("Up and Down while Ctrl is held", () => {
  it("moves the highlight at once, without waiting for the hold", () => {
    keys.hint(true);
    expect(keys.keydown(down("ArrowDown"))).toBe(true);
    expect(ui.highlight).toBe(0);
    expect(ui.numbers).toBe(true);
    keys.keydown(down("ArrowDown"));
    expect(ui.highlight).toBe(1);
  });

  it("loops at both ends", () => {
    keys.hint(true);
    keys.keydown(down("ArrowUp"));
    expect(ui.highlight).toBe(3);
    keys.keydown(down("ArrowDown"));
    expect(ui.highlight).toBe(0);
  });

  it("opens the highlighted chat on release", () => {
    keys.hint(true);
    keys.keydown(down("ArrowDown"));
    keys.keydown(down("ArrowDown"));
    keys.hint(false);
    expect(opened).toEqual([1]);
    expect(ui.highlight).toBe(-1);
  });

  it("Esc cancels: release opens nothing", () => {
    keys.hint(true);
    keys.keydown(down("ArrowDown"));
    expect(keys.keydown(down("Escape"))).toBe(false);
    keys.hint(false);
    expect(opened).toEqual([]);
    expect(ui.highlight).toBe(-1);
  });

  it("does nothing without Ctrl held, so the composer keeps its arrows", () => {
    expect(keys.keydown({ key: "ArrowDown", ctrlKey: false, shiftKey: false })).toBe(false);
    expect(ui.highlight).toBe(-1);
  });

  it("leaves the arrows alone with Shift held (text selection) and with no heads", () => {
    keys.hint(true);
    expect(keys.keydown({ key: "ArrowDown", ctrlKey: true, shiftKey: true })).toBe(false);
    count = 0;
    expect(keys.keydown(down("ArrowDown"))).toBe(false);
  });
});
