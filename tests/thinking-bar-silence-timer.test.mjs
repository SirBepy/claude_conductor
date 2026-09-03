// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Covers todo 871: the 5s silence interval must not outlive the pane, whose
// teardown calls initThinkingBar(null). Spies on setInterval/clearInterval
// rather than counting pending timers - mounting schedules unrelated one-shot
// timers too, so a global count is not evidence about this interval.
describe("thinking-bar silence timer", () => {
  let mod;
  let state;
  let setSpy;
  let clearSpy;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    state = (await import("../src/views/sessions/state.ts")).state;
    mod = await import("../src/views/sessions/session-thinking-bar.ts");
    setSpy = vi.spyOn(globalThis, "setInterval");
    clearSpy = vi.spyOn(globalThis, "clearInterval");
  });

  afterEach(() => {
    mod.initThinkingBar(null);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function mountBusyPane() {
    const pane = document.createElement("div");
    pane.innerHTML = `<div class="session-thinking"><span class="thinking-text"></span></div>`;
    document.body.appendChild(pane);
    state.sessions = [{ session_id: "s1", busy: true, awaiting: null }];
    state.selectedId = "s1";
    state.pendingNewSession = null;
    mod.initThinkingBar(pane);
    mod.updateThinkingBar();
    return pane;
  }

  /** The interval ids this module armed, in order. */
  function armedIds() {
    return setSpy.mock.results
      .filter((r, i) => setSpy.mock.calls[i]?.[1] === 5000)
      .map((r) => r.value);
  }

  it("arms a 5s interval while the session is busy", () => {
    mountBusyPane();
    expect(armedIds()).toHaveLength(1);
  });

  it("disarms on pane teardown instead of ticking forever", () => {
    mountBusyPane();
    const [id] = armedIds();

    mod.initThinkingBar(null);
    expect(clearSpy).toHaveBeenCalledWith(id);

    // Re-arming is the other half: a torn-down bar must not resurrect it.
    clearSpy.mockClear();
    vi.advanceTimersByTime(60_000);
    expect(armedIds()).toHaveLength(1);
  });

  it("disarms when the session stops being busy", () => {
    mountBusyPane();
    const [id] = armedIds();

    state.sessions[0].busy = false;
    mod.updateThinkingBar();
    expect(clearSpy).toHaveBeenCalledWith(id);
  });
});
