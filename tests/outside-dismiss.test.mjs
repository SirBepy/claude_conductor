// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest";
import { wireOutsideDismiss } from "../src/shared/outside-dismiss.ts";

function tick() {
  return new Promise((r) => setTimeout(r, 0));
}

function setup(box) {
  document.body.innerHTML = "";
  document.body.appendChild(box);
}

describe("wireOutsideDismiss", () => {
  it("does not dismiss for a target inside", async () => {
    const box = document.createElement("div");
    setup(box);
    const onDismiss = vi.fn();
    wireOutsideDismiss({ isInside: (t) => box.contains(t), onDismiss });
    await tick();
    box.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("dismisses for a target outside (mousedown default)", async () => {
    const box = document.createElement("div");
    setup(box);
    const onDismiss = vi.fn();
    wireOutsideDismiss({ isInside: (t) => box.contains(t), onDismiss });
    await tick();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("defers registration so the opening mousedown can't self-dismiss", () => {
    const box = document.createElement("div");
    setup(box);
    const onDismiss = vi.fn();
    wireOutsideDismiss({ isInside: (t) => box.contains(t), onDismiss });
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("pointerdown eventType ignores mousedown and reacts to pointerdown", async () => {
    const box = document.createElement("div");
    setup(box);
    const onDismiss = vi.fn();
    wireOutsideDismiss({ isInside: (t) => box.contains(t), onDismiss, eventType: "pointerdown" });
    await tick();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onDismiss).not.toHaveBeenCalled();
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape only when escape: true", async () => {
    const box = document.createElement("div");
    setup(box);
    const onDismiss = vi.fn();
    wireOutsideDismiss({ isInside: (t) => box.contains(t), onDismiss, escape: true });
    await tick();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("Escape is a no-op when escape is omitted (row-tooltip's shape)", async () => {
    const box = document.createElement("div");
    setup(box);
    const onDismiss = vi.fn();
    wireOutsideDismiss({ isInside: (t) => box.contains(t), onDismiss });
    await tick();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("dispose stops further dismissals", async () => {
    const box = document.createElement("div");
    setup(box);
    const onDismiss = vi.fn();
    const handle = wireOutsideDismiss({ isInside: (t) => box.contains(t), onDismiss });
    await tick();
    handle.dispose();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
