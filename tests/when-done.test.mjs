// @vitest-environment jsdom
//
// Unit tests for the sleep/shutdown-when-done protocol UI glue
// (src/views/sessions/when-done.ts).
//
// The module is a thin frontend layer over the daemon-owned protocol: it
// renders the overflow-menu markup for each ProtocolState phase, arms/cancels
// via Tauri IPC (with toggle semantics), and reconciles incoming
// `when-done-state` events into state.whenDone while notifying subscribers.
//
// We exercise three surfaces WITHOUT a real backend:
//   1. whenDoneMenuHtml() - fully pure given state.whenDone (per-phase markup).
//   2. armOrToggleWhenDone() - the arm / cancel / switch IPC decision, with a
//      mocked window.__TAURI__.core.invoke capturing (cmd, args).
//   3. event reconciliation - a mocked window.__TAURI__.event.listen lets us
//      fire a synthetic `when-done-state` payload and assert state + subscriber.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  armOrToggleWhenDone,
  cancelWhenDone,
  whenDoneArmed,
  whenDoneAction,
  whenDoneMenuHtml,
  initWhenDone,
  subscribeWhenDone,
} from "../src/views/sessions/when-done.ts";
import { state } from "../src/views/sessions/state.ts";

// Records of invoke(cmd, args). The mock returns whatever the test queued in
// `nextReturn` so apply() can run on the result.
let invokeCalls;
let nextReturn;
// The callback the module registered for the `when-done-state` event, captured
// so a test can fire a synthetic event payload at it.
let eventCb;

function ps(overrides = {}) {
  return {
    action: null,
    phase: "disarmed",
    countdown_remaining_secs: null,
    waiting_on: [],
    gave_up_reason: null,
    ...overrides,
  };
}

beforeEach(() => {
  invokeCalls = [];
  nextReturn = ps();
  eventCb = null;
  state.whenDone = null;
  globalThis.window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        invokeCalls.push({ cmd, args });
        return nextReturn;
      },
    },
    event: {
      listen: async (_name, cb) => {
        eventCb = cb;
        return () => { eventCb = null; };
      },
    },
  };
});

describe("whenDoneMenuHtml - per-phase markup", () => {
  it("disarmed: renders both toggle items, neither on, no chip", () => {
    state.whenDone = null;
    const html = whenDoneMenuHtml();
    expect(html).toContain('data-when-done="sleep"');
    expect(html).toContain('data-when-done="shutdown"');
    expect(html).not.toContain("is-on");
    expect(html).not.toContain("smore-check-dot");
    expect(html).not.toContain("when-done-chip");
  });

  it("watching (sleep, no idle sessions): sleep item on + armed chip", () => {
    state.whenDone = ps({ action: "sleep", phase: "watching", waiting_on: [] });
    const html = whenDoneMenuHtml();
    expect(html).toContain('data-when-done="sleep"');
    expect(html).toMatch(/is-on[^>]*data-when-done="sleep"|data-when-done="sleep"[^>]*is-on/);
    expect(html).toContain("smore-check-dot");
    expect(html).toContain("when-done-chip");
    expect(html).toContain("Sleep when done: armed");
    expect(html).not.toContain("waiting on");
  });

  it("watching (shutdown, waiting on 2 sessions): plural waiting-on copy", () => {
    state.whenDone = ps({ action: "shutdown", phase: "watching", waiting_on: ["a", "b"] });
    const html = whenDoneMenuHtml();
    expect(html).toContain("Shutdown when done: armed (waiting on 2 sessions)");
  });

  it("watching (waiting on 1 session): singular copy", () => {
    state.whenDone = ps({ action: "sleep", phase: "watching", waiting_on: ["a"] });
    const html = whenDoneMenuHtml();
    expect(html).toContain("waiting on 1 session)");
    expect(html).not.toContain("1 sessions");
  });

  it("countingDown (sleep): shows 'Sleep in {n}s' + Cancel control", () => {
    state.whenDone = ps({ action: "sleep", phase: "countingDown", countdown_remaining_secs: 12 });
    const html = whenDoneMenuHtml();
    expect(html).toContain("Sleep in 12s");
    expect(html).toContain("data-when-done-cancel");
  });

  it("countingDown (shutdown): shows 'Shutdown in {n}s'", () => {
    state.whenDone = ps({ action: "shutdown", phase: "countingDown", countdown_remaining_secs: 3 });
    const html = whenDoneMenuHtml();
    expect(html).toContain("Shutdown in 3s");
  });

  it("firing: shows '{label} now...'", () => {
    state.whenDone = ps({ action: "shutdown", phase: "firing" });
    const html = whenDoneMenuHtml();
    expect(html).toContain("Shutdown now...");
    // Still offers a cancel control during firing.
    expect(html).toContain("data-when-done-cancel");
  });

  it("whenDoneArmed / whenDoneAction reflect the armed state", () => {
    expect(whenDoneArmed()).toBe(false);
    expect(whenDoneAction()).toBe(null);
    state.whenDone = ps({ action: "sleep", phase: "watching" });
    expect(whenDoneArmed()).toBe(true);
    expect(whenDoneAction()).toBe("sleep");
  });

  // todo 894: an aborted (no-progress-guard) run persists a distinct GaveUp
  // phase instead of silently reverting to plain Disarmed, so it must read
  // differently from both "watching/armed" and "never armed" - visible, but
  // quiet (a single muted line, not a loud badge).
  it("gaveUp: toggle items are NOT shown as armed (distinguishable from a live arm)", () => {
    state.whenDone = ps({
      action: "shutdown",
      phase: "gaveUp",
      waiting_on: ["s1", "s2"],
      gave_up_reason: "no progress in Watching for 3 min (sessions never went idle)",
    });
    const html = whenDoneMenuHtml();
    expect(html).not.toContain("is-on");
    expect(html).not.toContain("smore-check-dot");
  });

  it("gaveUp: renders a muted line naming the reason and the blocking session count", () => {
    state.whenDone = ps({
      action: "shutdown",
      phase: "gaveUp",
      waiting_on: ["s1", "s2"],
      gave_up_reason: "no progress in Watching for 3 min (sessions never went idle)",
    });
    const html = whenDoneMenuHtml();
    expect(html).toContain("when-done-chip-gaveup");
    expect(html).toContain("gave up");
    expect(html).toContain("no progress in Watching for 3 min");
    expect(html).toContain("2 sessions");
    // Still clearable (re-arm or dismiss), distinguishable from a never-armed state.
    expect(html).toContain("data-when-done-cancel");
  });

  it("gaveUp: whenDoneArmed() is false (not indistinguishable-from-armed)", () => {
    expect(whenDoneArmed()).toBe(false);
    state.whenDone = ps({ action: "sleep", phase: "gaveUp", gave_up_reason: "x" });
    expect(whenDoneArmed()).toBe(false);
  });
});

describe("armOrToggleWhenDone - IPC decision", () => {
  it("arms sleep when disarmed: invokes arm_when_done with action=sleep", async () => {
    state.whenDone = null;
    nextReturn = ps({ action: "sleep", phase: "watching" });
    await armOrToggleWhenDone("sleep");
    expect(invokeCalls).toHaveLength(1);
    expect(invokeCalls[0].cmd).toBe("arm_when_done");
    expect(invokeCalls[0].args).toEqual({ action: "sleep" });
    // apply() ran on the result.
    expect(state.whenDone.action).toBe("sleep");
  });

  it("toggling the SAME armed action cancels: invokes cancel_when_done", async () => {
    state.whenDone = ps({ action: "sleep", phase: "watching" });
    nextReturn = ps();
    await armOrToggleWhenDone("sleep");
    expect(invokeCalls).toHaveLength(1);
    expect(invokeCalls[0].cmd).toBe("cancel_when_done");
    expect(state.whenDone.phase).toBe("disarmed");
  });

  it("arming the OTHER action while one is armed switches (arm, not cancel)", async () => {
    state.whenDone = ps({ action: "sleep", phase: "watching" });
    nextReturn = ps({ action: "shutdown", phase: "watching" });
    await armOrToggleWhenDone("shutdown");
    expect(invokeCalls).toHaveLength(1);
    expect(invokeCalls[0].cmd).toBe("arm_when_done");
    expect(invokeCalls[0].args).toEqual({ action: "shutdown" });
    expect(state.whenDone.action).toBe("shutdown");
  });

  it("cancelWhenDone always invokes cancel_when_done", async () => {
    state.whenDone = ps({ action: "shutdown", phase: "countingDown", countdown_remaining_secs: 5 });
    nextReturn = ps();
    await cancelWhenDone();
    expect(invokeCalls).toHaveLength(1);
    expect(invokeCalls[0].cmd).toBe("cancel_when_done");
    expect(state.whenDone.phase).toBe("disarmed");
  });
});

describe("when-done-state event reconciliation", () => {
  it("a fresh event payload updates state.whenDone and fires subscribers", async () => {
    // initWhenDone hydrates (get_when_done_state) then subscribes the listener.
    nextReturn = ps();
    const teardown = await initWhenDone();
    expect(invokeCalls[0].cmd).toBe("get_when_done_state");
    expect(typeof eventCb).toBe("function");

    const seen = [];
    const unsub = subscribeWhenDone((s) => seen.push(s));

    // Fire a synthetic event: daemon now watching for a sleep with 1 pending.
    const payload = ps({ action: "sleep", phase: "watching", waiting_on: ["s1"] });
    eventCb({ payload });

    expect(state.whenDone).toEqual(payload);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(payload);
    expect(whenDoneArmed()).toBe(true);

    unsub();
    teardown();
  });

  it("countingDown event starts a local 1s smoothing decrement", async () => {
    vi.useFakeTimers();
    try {
      const teardown = await initWhenDone();
      const seen = [];
      subscribeWhenDone((s) => seen.push(s));

      eventCb({ payload: ps({ action: "sleep", phase: "countingDown", countdown_remaining_secs: 10 }) });
      expect(state.whenDone.countdown_remaining_secs).toBe(10);

      vi.advanceTimersByTime(1000);
      expect(state.whenDone.countdown_remaining_secs).toBe(9);
      vi.advanceTimersByTime(2000);
      expect(state.whenDone.countdown_remaining_secs).toBe(7);

      teardown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an unsubscribed listener no longer fires", async () => {
    const teardown = await initWhenDone();
    const seen = [];
    const unsub = subscribeWhenDone((s) => seen.push(s));
    unsub();
    eventCb({ payload: ps({ action: "shutdown", phase: "watching" }) });
    expect(seen).toHaveLength(0);
    teardown();
  });
});
