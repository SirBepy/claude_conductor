// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Phone signal blips for a second or two constantly; the strip must stay
// hidden through those and only appear once the link has been down 5s.

vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => true }));

const conn = await import("../src/shared/connection-state.ts");
const { mountReconnectStrip } = await import("../src/shared/reconnect-strip.ts");

describe("reconnect strip delay", () => {
  let unmount = () => {};

  beforeEach(() => {
    vi.useFakeTimers();
    conn.resetConnectionState();
    unmount = mountReconnectStrip();
  });

  afterEach(() => {
    unmount();
    vi.useRealTimers();
  });

  const strip = () => document.querySelector(".reconnect-strip");

  it("stays hidden through a drop shorter than 5s", () => {
    conn.reportRequestFailure();
    vi.advanceTimersByTime(4_500);
    expect(strip()?.hidden).toBe(true);
    conn.reportRequestSuccess();
    vi.advanceTimersByTime(2_000);
    expect(strip()?.hidden).toBe(true);
  });

  it("shows once the link has been down 5s", () => {
    conn.reportRequestFailure();
    vi.advanceTimersByTime(5_500);
    expect(strip()?.hidden).toBe(false);
    expect(strip()?.textContent).toContain("Reconnecting to your PC");
  });

  it("restarts the grace period and the count when the page becomes visible again", () => {
    conn.markLiveUp();
    conn.markLiveDown();
    vi.advanceTimersByTime(6_000);
    expect(strip()?.hidden).toBe(false);
    // Hidden for a long time: the strip's own tick does not run meanwhile.
    vi.setSystemTime(Date.now() + 400_000);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(strip()?.hidden).toBe(true);
    vi.advanceTimersByTime(4_500);
    expect(strip()?.hidden).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(strip()?.hidden).toBe(false);
    expect(strip()?.textContent).toMatch(/Reconnecting to your PC… [56]s/);
  });
});
