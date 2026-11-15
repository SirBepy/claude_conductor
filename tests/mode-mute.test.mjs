// @vitest-environment jsdom
// asserts: src/shared/mode-mute.ts
// asserts: src/shared/notification-listeners.ts

// `mute_conductor` (daemon::modes) silences the one sound the webview makes itself:
// the OS notification for a missed scheduled item. The flag is seeded from `get_mode`
// and kept current by the `mode-changed` event.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock, listeners } = vi.hoisted(() => ({ invokeMock: vi.fn(), listeners: new Map() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));
vi.mock("../src/shared/transport.ts", () => ({
  getTransport: () => ({
    listen: async (event, cb) => {
      listeners.set(event, cb);
      return () => listeners.delete(event);
    },
  }),
}));
vi.mock("../src/shared/toast.ts", () => ({ showToast: vi.fn() }));
vi.mock("../src/shared/navigation.ts", () => ({ showView: vi.fn() }));
vi.mock("../src/missed-panel.ts", () => ({ updateMissedPanel: vi.fn() }));

const { applyMode, isConductorMuted, initModeMute, resetModeMuteForTest } = await import("../src/shared/mode-mute.ts");
const { setupScheduleMissedPopup } = await import("../src/shared/notification-listeners.ts");

const HOUR = 3600_000;
const sleepMuted = (extra = {}) => ({ mode: "sleep", flags: ["mute_conductor"], until: null, ...extra });
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  invokeMock.mockReset();
  listeners.clear();
  resetModeMuteForTest();
});

describe("applyMode", () => {
  it("mutes only a mode that carries the flag", () => {
    applyMode(sleepMuted());
    expect(isConductorMuted()).toBe(true);
    applyMode({ mode: "sleep", flags: ["test_without_asking"] });
    expect(isConductorMuted()).toBe(false);
    applyMode({ mode: null, flags: ["mute_conductor"] });
    expect(isConductorMuted(), "no mode means no mute, whatever the stale flags say").toBe(false);
    applyMode(null);
    expect(isConductorMuted()).toBe(false);
  });

  it("stops muting once the end time has passed, and treats an unreadable one as passed", () => {
    applyMode(sleepMuted({ until: new Date(Date.now() + HOUR).toISOString() }));
    expect(isConductorMuted()).toBe(true);
    applyMode(sleepMuted({ until: new Date(Date.now() - HOUR).toISOString() }));
    expect(isConductorMuted()).toBe(false);
    applyMode(sleepMuted({ until: "tomorrow-ish" }));
    expect(isConductorMuted()).toBe(false);
  });
});

describe("initModeMute", () => {
  it("seeds from get_mode and follows mode-changed", async () => {
    invokeMock.mockResolvedValue(sleepMuted());
    initModeMute();
    await flush();
    expect(invokeMock).toHaveBeenCalledWith("get_mode");
    expect(isConductorMuted()).toBe(true);
    listeners.get("mode-changed")({ mode: null, flags: [], until: null });
    expect(isConductorMuted()).toBe(false);
    listeners.get("mode-changed")(sleepMuted());
    expect(isConductorMuted()).toBe(true);
  });

  it("stays unmuted when the daemon cannot answer", async () => {
    invokeMock.mockRejectedValue(new Error("daemon client not connected"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    initModeMute();
    await flush();
    expect(isConductorMuted()).toBe(false);
    warn.mockRestore();
  });
});

describe("the missed-schedule OS notification", () => {
  let n = 0;

  async function fireMissed() {
    // A fresh id each time: the listener remembers the ids it already notified about.
    const missed = { id: `m${++n}`, status: { type: "missed" }, kind: { type: "message" }, prompt: "ping", fire_at: new Date().toISOString(), last_fired_at: null };
    invokeMock.mockImplementation(async (cmd) => (cmd === "schedule_list" ? [missed] : sleepMutedForCall()));
    setupScheduleMissedPopup();
    await flush();
    await listeners.get("scheduled-items-changed")();
  }
  let sleepMutedForCall = () => ({ mode: null, flags: [] });

  beforeEach(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    globalThis.Notification = Object.assign(vi.fn(), { permission: "granted", requestPermission: vi.fn() });
  });

  it("is shown while no mode mutes Conductor", async () => {
    sleepMutedForCall = () => ({ mode: null, flags: [] });
    await fireMissed();
    expect(globalThis.Notification).toHaveBeenCalledTimes(1);
  });

  it("is not shown while mute_conductor is on", async () => {
    sleepMutedForCall = () => sleepMuted();
    await fireMissed();
    expect(globalThis.Notification).not.toHaveBeenCalled();
  });
});
