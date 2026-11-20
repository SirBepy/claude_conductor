// @vitest-environment jsdom
//
// A chat's title swaps with a typewriter: backspace to the text the old and new
// titles share, then type the rest. Covers the header path: an element that
// already shows the old title.

import { describe, it, expect, beforeEach, vi } from "vitest";

const { typeSwap, titleShown, titleTarget, cancelTitleSwap } = await import("../src/shared/title-typewriter.ts");

globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);

function span(text) {
  const el = document.createElement("span");
  el.textContent = text;
  document.body.appendChild(el);
  return el;
}

describe("typeSwap", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
  });

  it("erases the old title, then types the new one", () => {
    const el = span("New chat");
    typeSwap(el, "Fix login bug");
    // Mid-erase: shorter than the old title, nothing of the new one yet.
    vi.advanceTimersByTime(30);
    expect("New chat".startsWith(el.textContent)).toBe(true);
    expect(el.textContent.length).toBeLessThan("New chat".length);
    vi.runAllTimers();
    expect(el.textContent).toBe("Fix login bug");
    expect(titleShown(el)).toBe("Fix login bug");
  });

  it("only backspaces to the shared prefix", () => {
    const el = span("Fix login");
    typeSwap(el, "Fix logout");
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      vi.advanceTimersByTime(10);
      seen.add(el.textContent);
    }
    expect(el.textContent).toBe("Fix logout");
    // "Fix log" is the shared stem: it never erases past it.
    expect([...seen].every((s) => s.length >= "Fix log".length)).toBe(true);
  });

  it("a newer swap resumes from the half-typed text", () => {
    const el = span("New chat");
    typeSwap(el, "Alpha beta");
    vi.advanceTimersByTime(400);
    typeSwap(el, "Alpha gamma");
    vi.runAllTimers();
    expect(el.textContent).toBe("Alpha gamma");
    expect(titleTarget(el)).toBe("Alpha gamma");
  });

  it("a burst of same-target calls does not stall the swap in flight", () => {
    const el = span("New chat");
    typeSwap(el, "Fix login bug");
    // instances-changed fires every few ms while streaming; each re-asserts the
    // title the header is already heading to.
    for (let i = 0; i < 100; i++) {
      vi.advanceTimersByTime(10);
      typeSwap(el, "Fix login bug");
    }
    expect(el.textContent).toBe("Fix login bug");
  });

  it("an outright set cancels a swap still typing", () => {
    const el = span("New chat");
    typeSwap(el, "Alpha beta gamma");
    vi.advanceTimersByTime(300);
    typeSwap(el, "Other", { animate: false });
    vi.runAllTimers();
    expect(el.textContent).toBe("Other");
  });

  it("cancelTitleSwap stops the timer and leaves the text", () => {
    const el = span("New chat");
    typeSwap(el, "Alpha beta");
    vi.advanceTimersByTime(30);
    const frozen = el.textContent;
    cancelTitleSwap(el);
    vi.runAllTimers();
    expect(el.textContent).toBe(frozen);
  });

  it("leaves an unchanged title untouched", () => {
    const el = span("Same");
    const child = el.firstChild;
    typeSwap(el, "Same");
    expect(el.firstChild).toBe(child);
  });

  it("sets text outright when animation is off", () => {
    const el = span("Old");
    typeSwap(el, "New", { animate: false });
    expect(el.textContent).toBe("New");
  });

  it("keeps the line from collapsing while the title is empty", () => {
    const el = span("ab");
    typeSwap(el, "zz");
    vi.advanceTimersByTime(30);
    expect(el.textContent).toBe("​");
  });

  it("never paints half of an emoji while erasing or typing across one", () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    // The two emoji share their high surrogate, so a unit-wise prefix stops inside the pair.
    const el = span("Fix \u{1F600} bug");
    typeSwap(el, "Fix \u{1F601} bug");
    const frames = new Set();
    for (let i = 0; i < 400; i++) {
      vi.advanceTimersByTime(5);
      frames.add(el.textContent);
    }
    expect(el.textContent).toBe("Fix \u{1F601} bug");
    expect([...frames].filter((f) => lone.test(f))).toEqual([]);
  });
});
