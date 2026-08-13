import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { debounce } = await import("../src/shared/debounce.ts");

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("debounce", () => {
  it("coalesces rapid calls into a single trailing-edge invocation", () => {
    const fn = vi.fn();
    const d = debounce(fn, 500);

    d("a");
    vi.advanceTimersByTime(100);
    d("b");
    vi.advanceTimersByTime(100);
    d("c");
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("c");
  });

  it("fires again after the wait if called again later", () => {
    const fn = vi.fn();
    const d = debounce(fn, 500);
    d("first");
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);

    d("second");
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("second");
  });

  it("flush() runs a pending call immediately, bypassing the wait", () => {
    const fn = vi.fn();
    const d = debounce(fn, 500);
    d("pending");
    expect(fn).not.toHaveBeenCalled();

    d.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("pending");

    // The timer must not also fire later - flush already consumed it.
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("flush() is a no-op when nothing is pending", () => {
    const fn = vi.fn();
    const d = debounce(fn, 500);
    d.flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it("cancel() drops a pending call without running it", () => {
    const fn = vi.fn();
    const d = debounce(fn, 500);
    d("dropped");
    d.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("a call after flush() starts a fresh debounce window", () => {
    const fn = vi.fn();
    const d = debounce(fn, 500);
    d("one");
    d.flush();
    d("two");
    vi.advanceTimersByTime(499);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("two");
  });
});
