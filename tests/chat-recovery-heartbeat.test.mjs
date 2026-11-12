// @vitest-environment jsdom

// On the phone the chat socket heals itself (heartbeat watchdog) and re-reads on
// reconnect, so the recovery heartbeat must not rebuild a healthy socket every
// 15s, must not run while hidden, and must read once per return to the app. The
// desktop keeps its 15s revive + forced re-read, pinned here.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  remote: false,
  revive: vi.fn(async () => {}),
  reconcile: vi.fn(async () => {}),
  cached: [],
}));

vi.mock("../src/shared/transport", () => ({ isRemote: () => h.remote, getTransport: () => ({}) }));
vi.mock("../src/shared/chat/event-store", () => ({
  sessionEvents: {
    reviveListener: (...a) => h.revive(...a),
    reconcileLatest: (...a) => h.reconcile(...a),
    cachedSessionIdsByRecency: () => h.cached,
  },
}));
vi.mock("../src/views/sessions/state", () => ({
  state: { mountId: 1, selectedId: "chat-1", sessions: [{ session_id: "chat-1", cwd: "/p" }] },
  setActiveSession: () => {},
  loadLastSelectedSession: () => {},
}));
// The rest of sessions-wiring's imports are never touched by the heartbeat.
vi.mock("../src/views/sessions/active-session", () => ({}));
vi.mock("../src/views/sessions/active-session-account", () => ({}));
vi.mock("../src/views/sessions/session-thinking-bar", () => ({}));
vi.mock("../src/views/sessions/sessions-helpers", () => ({}));
vi.mock("../src/views/sessions/sidebar", () => ({}));
vi.mock("../src/views/sessions/session-characters", () => ({}));
vi.mock("../src/views/sessions/usage-dials", () => ({}));
vi.mock("../src/views/sessions/chat-pane-cache", () => ({}));
vi.mock("../src/views/sessions/successor-follow", () => ({}));
vi.mock("../src/views/sessions/pane-freeze", () => ({}));
vi.mock("../src/views/sessions/hidden-sessions-sync", () => ({}));
vi.mock("../src/views/sessions/machine-icons", () => ({}));
vi.mock("../src/views/sessions/subchat-view", () => ({}));
vi.mock("../src/views/sessions/chat-dashboard/chat-dashboard", () => ({}));
vi.mock("../src/shared/characters", () => ({}));
vi.mock("../src/shared/api", () => ({}));
vi.mock("../src/shared/title-typewriter", () => ({}));
vi.mock("../src/shared/chat/rate-limit-banner", () => ({}));

const { wireChatRecoveryHeartbeat } = await import("../src/views/sessions/sessions-wiring.ts");

let visibility;
let dispose;
function setVisibility(v) {
  visibility = v;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  h.remote = false;
  h.revive.mockClear();
  h.reconcile.mockClear();
  h.cached = [];
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  vi.useFakeTimers();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.useRealTimers();
});

describe("phone", () => {
  beforeEach(() => { h.remote = true; });

  it("60s of ticks never rebuild the socket and read at most once", async () => {
    dispose = wireChatRecoveryHeartbeat(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.revive).not.toHaveBeenCalled();
    expect(h.reconcile.mock.calls.filter((c) => c[0] === "chat-1").length).toBeLessThanOrEqual(1);
  });

  it("a forced re-read is never used", async () => {
    dispose = wireChatRecoveryHeartbeat(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.reconcile.mock.calls.every((c) => !c[2]?.force)).toBe(true);
  });

  it("focus and visibilitychange together make exactly one re-read", async () => {
    dispose = wireChatRecoveryHeartbeat(1);
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    expect(h.revive).not.toHaveBeenCalled();
  });

  it("a hidden page reads nothing", async () => {
    setVisibility("hidden");
    dispose = wireChatRecoveryHeartbeat(1);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it("resume passes do not advance the sweep cadence", async () => {
    h.cached = ["chat-1", "bg-1"];
    dispose = wireChatRecoveryHeartbeat(1);
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      window.dispatchEvent(new Event("focus"));
    }
    expect(h.reconcile.mock.calls.some((c) => c[0] === "bg-1")).toBe(false);
  });

  it("every 4th slow tick sweeps the other cached chats", async () => {
    h.cached = ["chat-1", "bg-1"];
    dispose = wireChatRecoveryHeartbeat(1);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(h.reconcile.mock.calls.filter((c) => c[0] === "bg-1")).toHaveLength(1);
  });
});

describe("desktop", () => {
  it("revives the listener and force-reads on every 15s tick, hidden or not", async () => {
    setVisibility("hidden");
    dispose = wireChatRecoveryHeartbeat(1);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(h.revive).toHaveBeenCalledTimes(3);
    expect(h.reconcile).toHaveBeenCalledTimes(3);
    expect(h.reconcile).toHaveBeenCalledWith("chat-1", "/p", { force: true });
  });

  it("recovers on focus and on regaining visibility", async () => {
    dispose = wireChatRecoveryHeartbeat(1);
    window.dispatchEvent(new Event("focus"));
    expect(h.revive).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(h.revive).toHaveBeenCalledTimes(2);
  });

  it("sweeps the other cached chats on every 4th tick", async () => {
    h.cached = ["chat-1", "bg-1"];
    dispose = wireChatRecoveryHeartbeat(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.reconcile.mock.calls.filter((c) => c[0] === "bg-1")).toHaveLength(1);
  });
});
