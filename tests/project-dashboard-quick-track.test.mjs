// @vitest-environment jsdom
//
// The quick-action chip row scrolls sideways: a plain wheel turn moves it
// (until an end, then the page scrolls), the scrollbar shows only while it
// moves, and each edge fades only while chips lie past it. jsdom has no
// layout, so each track gets its scroll box stubbed.

import { describe, it, expect, vi, afterEach } from "vitest";
import { onTrackScroll, onTrackWheel, syncEdges } from "../src/views/sessions/project-dashboard/quick-track.ts";

/** A track 300px wide over 1000px of chips, scrolled to `left`. */
function track(left = 0, scrollWidth = 1000, clientWidth = 300) {
  const el = document.createElement("div");
  let pos = left;
  Object.defineProperty(el, "scrollLeft", { configurable: true, get: () => pos, set: (v) => { pos = Math.max(0, Math.min(v, scrollWidth - clientWidth)); } });
  Object.defineProperty(el, "scrollWidth", { configurable: true, get: () => scrollWidth });
  Object.defineProperty(el, "clientWidth", { configurable: true, get: () => clientWidth });
  return el;
}

function wheel(el, deltaY, deltaX = 0) {
  const e = { currentTarget: el, deltaX, deltaY, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  onTrackWheel(e);
  return e;
}

afterEach(() => { vi.useRealTimers(); });

describe("chip row wheel", () => {
  it("turns a vertical wheel into a sideways scroll and keeps the page still", () => {
    const el = track();
    const e = wheel(el, 120);
    expect(el.scrollLeft).toBe(120);
    expect(e.defaultPrevented).toBe(true);
  });

  it("hands the wheel back to the page at either end", () => {
    const end = track(700);
    expect(wheel(end, 120).defaultPrevented).toBe(false);
    expect(end.scrollLeft).toBe(700);
    const start = track(0);
    expect(wheel(start, -120).defaultPrevented).toBe(false);
  });

  it("leaves a row that already fits, and a sideways (trackpad) gesture, to the browser", () => {
    expect(wheel(track(0, 300, 300), 120).defaultPrevented).toBe(false);
    expect(wheel(track(), 0, 40).defaultPrevented).toBe(false);
  });
});

describe("chip row scrollbar and edges", () => {
  it("shows the scrollbar while scrolling and hides it once scrolling stops", () => {
    vi.useFakeTimers();
    const el = track(100);
    onTrackScroll({ currentTarget: el });
    expect(el.classList.contains("is-scrolling")).toBe(true);
    vi.advanceTimersByTime(400);
    onTrackScroll({ currentTarget: el });
    vi.advanceTimersByTime(400);
    // The second scroll restarted the idle clock.
    expect(el.classList.contains("is-scrolling")).toBe(true);
    vi.advanceTimersByTime(400);
    expect(el.classList.contains("is-scrolling")).toBe(false);
  });

  it("fades only the edges that have chips past them", () => {
    const fades = (el) => { syncEdges(el); return [el.classList.contains("fade-l"), el.classList.contains("fade-r")]; };
    expect(fades(track(0))).toEqual([false, true]);
    expect(fades(track(300))).toEqual([true, true]);
    expect(fades(track(700))).toEqual([true, false]);
    expect(fades(track(0, 300, 300))).toEqual([false, false]);
  });
});
