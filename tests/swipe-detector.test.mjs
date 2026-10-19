// @vitest-environment jsdom
//
// attachSwipe serves two gestures with different cross-axis rules: the
// page-swipe (axis x) drops a drag the moment the other axis dominates, the
// preview stage-swipe (axis y, dropOnCrossAxis false) keeps tracking through
// a sideways wobble and judges only the start-to-end delta.

import { describe, it, expect, vi } from "vitest";
import { attachSwipe } from "../src/views/sessions/permission-modal/swipe-detector.ts";

function touch(type, host, x, y) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  const pt = { clientX: x, clientY: y };
  Object.defineProperty(e, "touches", { value: type === "touchend" ? [] : [pt] });
  Object.defineProperty(e, "changedTouches", { value: [pt] });
  host.dispatchEvent(e);
  return e;
}

function drag(host, points) {
  const [first, ...rest] = points;
  touch("touchstart", host, ...first);
  for (const p of rest) touch("touchmove", host, ...p);
  touch("touchend", host, ...points[points.length - 1]);
}

describe("attachSwipe", () => {
  it("y-axis stage-swipe with dropOnCrossAxis false survives an early sideways wobble", () => {
    const host = document.createElement("div");
    const onSwipe = vi.fn();
    attachSwipe(host, { axis: "y", dropOnCrossAxis: false, onSwipe });
    // First move is mostly sideways, then the drag straightens upward.
    drag(host, [[100, 200], [112, 198], [110, 160], [108, 120]]);
    expect(onSwipe).toHaveBeenCalledTimes(1);
    expect(onSwipe.mock.calls[0][0]).toBe(1);
  });

  it("y-axis stage-swipe still ignores a drag whose overall motion is sideways", () => {
    const host = document.createElement("div");
    const onSwipe = vi.fn();
    attachSwipe(host, { axis: "y", dropOnCrossAxis: false, onSwipe });
    drag(host, [[100, 200], [160, 180], [220, 150]]);
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("x-axis page-swipe (default) drops the gesture once the other axis dominates", () => {
    const host = document.createElement("div");
    const onSwipe = vi.fn();
    attachSwipe(host, { axis: "x", onSwipe });
    drag(host, [[200, 100], [198, 115], [150, 112], [100, 110]]);
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("x-axis page-swipe fires on a clean horizontal drag", () => {
    const host = document.createElement("div");
    const onSwipe = vi.fn();
    attachSwipe(host, { axis: "x", onSwipe });
    drag(host, [[200, 100], [160, 102], [120, 104]]);
    expect(onSwipe).toHaveBeenCalledTimes(1);
    expect(onSwipe.mock.calls[0][0]).toBe(1);
  });
});
