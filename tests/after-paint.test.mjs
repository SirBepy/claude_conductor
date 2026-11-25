// @vitest-environment jsdom
// afterPaint: a frame when frames run, a timer when they are paused, once either way.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { afterPaint } from "../src/shared/after-paint.ts";

let frames;
beforeEach(() => {
  vi.useFakeTimers();
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb) => frames.push(cb));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const runFrame = () => frames.splice(0).forEach((cb) => cb());

describe("afterPaint", () => {
  it("runs once on the frame, and the timer after it does nothing", () => {
    const fn = vi.fn();
    afterPaint(fn);
    expect(fn).not.toHaveBeenCalled();
    runFrame();
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("runs from the timer when no frame ever comes", () => {
    const fn = vi.fn();
    afterPaint(fn);
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("waits for two frames when asked, and still falls back", () => {
    const fn = vi.fn();
    afterPaint(fn, 2);
    runFrame();
    expect(fn).not.toHaveBeenCalled();
    runFrame();
    expect(fn).toHaveBeenCalledTimes(1);

    const late = vi.fn();
    afterPaint(late, 2);
    vi.advanceTimersByTime(400);
    expect(late).toHaveBeenCalledTimes(1);
  });
});
