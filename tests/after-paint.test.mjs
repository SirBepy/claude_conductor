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

  it("runs from the timer when no frame ever comes, 64ms per frame", () => {
    const fn = vi.fn();
    afterPaint(fn);
    vi.advanceTimersByTime(63);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);

    const two = vi.fn();
    afterPaint(two, 2);
    vi.advanceTimersByTime(127);
    expect(two).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(two).toHaveBeenCalledTimes(1);
  });

  it("a frame that arrives after the timer already ran does not run it again", () => {
    const fn = vi.fn();
    afterPaint(fn);
    vi.advanceTimersByTime(64);
    runFrame();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("finishes by timer when frames pause after the first of two", () => {
    const fn = vi.fn();
    afterPaint(fn, 2);
    runFrame();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(128);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("runs from the timer when requestAnimationFrame does not exist", () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    const fn = vi.fn();
    afterPaint(fn);
    vi.advanceTimersByTime(64);
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
