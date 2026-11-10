// @vitest-environment jsdom
// The page-state channel: a page's save reaches the host after a pause, under the preview
// that was in view when it saved; a restore reaches the page on load; another window's
// change moves the page, but this window's own echo does not.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PageStateBridge, PAGE_STATE_DEBOUNCE_MS } from "../src/views/sessions/preview-page-state.ts";
import { stateKey, parseStateKey } from "../src/views/sessions/shared-mockup-model.ts";

function setup(initial) {
  const posted = [];
  const contentWindow = { postMessage: (m) => posted.push(m) };
  const frame = { contentWindow };
  const host = {
    current: "p1",
    stored: initial,
    saved: [],
    frame: () => frame,
    id: () => host.current,
    save: (id, value) => host.saved.push([id, value]),
  };
  host.stored = () => initial;
  const bridge = new PageStateBridge(host);
  const fromPage = (value, source = contentWindow) =>
    window.dispatchEvent(new MessageEvent("message", { data: { cc: "state", value }, source }));
  return { bridge, host, posted, fromPage, contentWindow };
}

describe("PageStateBridge", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("saves only the last value of a burst, after the pause", () => {
    const { bridge, host, fromPage } = setup(undefined);
    fromPage({ slide: 1 });
    fromPage({ slide: 2 });
    fromPage({ slide: 5 });
    expect(host.saved).toEqual([]);
    vi.advanceTimersByTime(PAGE_STATE_DEBOUNCE_MS);
    expect(host.saved).toEqual([["p1", { slide: 5 }]]);
    bridge.destroy();
  });

  it("files a pending save under the preview it came from when the view moves on", () => {
    const { bridge, host, fromPage } = setup(undefined);
    fromPage({ slide: 5 });
    host.current = "p2";
    fromPage({ tab: "b" });
    vi.advanceTimersByTime(PAGE_STATE_DEBOUNCE_MS);
    expect(host.saved).toEqual([["p1", { slide: 5 }], ["p2", { tab: "b" }]]);
    bridge.destroy();
  });

  it("ignores a message from another window than the page frame", () => {
    const { bridge, host, fromPage } = setup(undefined);
    fromPage({ slide: 9 }, {});
    vi.advanceTimersByTime(PAGE_STATE_DEBOUNCE_MS);
    expect(host.saved).toEqual([]);
    bridge.destroy();
  });

  it("restores the stored value on load and posts nothing when there is none", () => {
    const a = setup({ slide: 5 });
    a.bridge.restore();
    expect(a.posted).toEqual([{ cc: "restore", value: { slide: 5 } }]);
    a.bridge.destroy();
    const b = setup(undefined);
    b.bridge.restore();
    expect(b.posted).toEqual([]);
    b.bridge.destroy();
  });

  it("follows another window's change but not its own echo", () => {
    const { bridge, posted } = setup(undefined);
    bridge.follow({ slide: 5 }, { slide: 5 });
    expect(posted).toEqual([]);
    bridge.follow({ slide: 5 }, { slide: 7 });
    expect(posted).toEqual([{ cc: "restore", value: { slide: 7 } }]);
    bridge.destroy();
  });

  it("flushes a pending save when destroyed, so closing the pop-out at slide 5 keeps slide 5", () => {
    const { bridge, host, fromPage } = setup(undefined);
    fromPage({ slide: 5 });
    bridge.destroy();
    expect(host.saved).toEqual([["p1", { slide: 5 }]]);
  });
});

describe("control state keys", () => {
  it("round-trips a control and refuses the page key and malformed keys", () => {
    expect(parseStateKey(stateKey("header", "dense"))).toEqual({ partId: "header", controlId: "dense" });
    expect(parseStateKey("page")).toBeNull();
    expect(parseStateKey("ctl|header")).toBeNull();
    expect(parseStateKey("ctl|a|b|c")).toBeNull();
  });
});
