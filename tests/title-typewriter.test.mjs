// @vitest-environment jsdom
//
// A chat's title swaps with a typewriter: backspace to the text the old and new
// titles share, then type the rest. Covers the header path (an element that
// already shows the old title) and the sidebar path (a rebuilt row that holds
// the final title and is told what the old row was showing).

import { describe, it, expect, beforeEach, vi } from "vitest";

const { typeSwap, titleShown, titleTarget, cancelTitleSwap } = await import("../src/shared/title-typewriter.ts");
const { reconcileList } = await import("../src/views/sessions/sidebar-anim.ts");

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
});

describe("sidebar row title", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
  });

  const row = (title) => ({
    key: "s:a",
    html: `<li data-session-id="a"><span class="session-row-title-text">${title}</span></li>`,
  });

  it("retypes a changed title in place", () => {
    const ul = document.createElement("ul");
    document.body.appendChild(ul);
    reconcileList(ul, [row("New chat")], true);
    vi.runAllTimers();
    reconcileList(ul, [row("Fix login bug")], true);
    const el = ul.querySelector(".session-row-title-text");
    // Rebuilt row starts from the old text, not the final one.
    expect(el.textContent).not.toBe("Fix login bug");
    vi.runAllTimers();
    expect(el.textContent).toBe("Fix login bug");
  });

  it("sets the title outright when sidebar animations are off", () => {
    const ul = document.createElement("ul");
    document.body.appendChild(ul);
    reconcileList(ul, [row("New chat")], false);
    reconcileList(ul, [row("Fix login bug")], false);
    expect(ul.querySelector(".session-row-title-text").textContent).toBe("Fix login bug");
  });
});
