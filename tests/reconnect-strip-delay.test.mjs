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
});
