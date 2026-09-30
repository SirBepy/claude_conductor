// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { visibleInterval } from "../src/shared/visible-interval.ts";

function setVisibility(state) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("visibleInterval", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks on the given cadence while visible", () => {
    const fn = vi.fn();
    const dispose = visibleInterval(fn, 1000);

    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(3);

    dispose();
  });

  it("pauses ticks while hidden by default", () => {
    const fn = vi.fn();
    const dispose = visibleInterval(fn, 1000);

    setVisibility("hidden");
    fn.mockClear();
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();

    dispose();
  });

  it("flushes once immediately on becoming visible after a skipped tick, then resumes cadence", () => {
    const fn = vi.fn();
    const dispose = visibleInterval(fn, 1000);
    fn.mockClear();

    setVisibility("hidden");
    vi.advanceTimersByTime(2500); // two skipped ticks
    expect(fn).not.toHaveBeenCalled();

    setVisibility("visible"); // flush
    expect(fn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000); // normal cadence resumes
    expect(fn).toHaveBeenCalledTimes(2);

    dispose();
  });

  it("does not flush on becoming visible if no tick was skipped", () => {
    const fn = vi.fn();
    const dispose = visibleInterval(fn, 1000);
    fn.mockClear();

    // Already visible; a visibilitychange to "visible" with nothing skipped
    // must not fire an extra call.
    setVisibility("visible");
    expect(fn).not.toHaveBeenCalled();

    dispose();
  });

  it("keeps ticking while hidden when whileHidden is set", () => {
    const fn = vi.fn();
    const dispose = visibleInterval(fn, 1000, { whileHidden: true, reason: "test: must reach the user" });
    fn.mockClear();

    setVisibility("hidden");
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(3);

    dispose();
  });

  it("disposer clears the timer and removes the listener", () => {
    const fn = vi.fn();
    const dispose = visibleInterval(fn, 1000);
    fn.mockClear();

    dispose();

    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();

    // A visibility change after disposal must not resurrect it either.
    setVisibility("hidden");
    setVisibility("visible");
    expect(fn).not.toHaveBeenCalled();
  });
});
