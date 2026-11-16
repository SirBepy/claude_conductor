// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Phone signal blips for a second or two constantly; the strip must stay
// hidden through those and only appear once the link has been down 5s.

vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => true }));
const note = vi.fn();
vi.mock("../src/shared/link-journal.ts", () => ({ note }));

const conn = await import("../src/shared/connection-state.ts");
const { mountReconnectStrip } = await import("../src/shared/reconnect-strip.ts");

describe("reconnect strip delay", () => {
  let unmount = () => {};

  beforeEach(() => {
    vi.useFakeTimers();
    conn.resetConnectionState();
    note.mockClear();
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

  it("journals why the strip came up", () => {
    conn.reportRequestFailure();
    vi.advanceTimersByTime(5_500);
    expect(note).toHaveBeenCalledWith("strip_show", expect.stringMatching(/^Reconnecting to your PC… \d+s cause=requests$/));
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

// Journal 2026-11-13/14: five of the thirteen "Reconnecting 2226s"-style strip_show
// lines were followed by strip_hide within 1-10ms of the page becoming visible.
// A tick that began counting just before the page was hidden kept its start time
// through the whole stay, so the first tick after the return saw a link "down
// for 37 minutes", showed the strip and logged it, and the resume handler hid it
// again. Nothing was drawn, but the journal read as 37-minute outages.
describe("reconnect strip after a long stay hidden", () => {
  let unmount = () => {};
  const setVisibility = (state) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    document.dispatchEvent(new Event("visibilitychange"));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    conn.resetConnectionState();
    unmount = mountReconnectStrip();
  });

  afterEach(() => {
    unmount();
    setVisibility("visible");
    vi.useRealTimers();
  });

  it("never flashes the strip on return from a stay that began mid-failure", () => {
    const strip = document.querySelector(".reconnect-strip");
    const writes = [];
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "hidden");
    Object.defineProperty(strip, "hidden", {
      configurable: true,
      get() { return desc.get.call(this); },
      set(v) { writes.push(v); desc.set.call(this, v); },
    });
    // A failing request starts the strip's grace count, then the page is hidden
    // before the 5s are up.
    conn.reportRequestFailure();
    vi.advanceTimersByTime(1_500);
    setVisibility("hidden");
    vi.setSystemTime(Date.now() + 2_226_000);
    writes.length = 0;
    // The interval's own flush tick is the first listener to run on return; the
    // strip must stay hidden through it, not only after the resume handler.
    setVisibility("visible");
    expect(writes).not.toContain(false);
    expect(strip.hidden).toBe(true);
  });
});
