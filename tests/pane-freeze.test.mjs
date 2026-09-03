// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

const { freezePane } = await import("../src/views/sessions/pane-freeze.ts");

function buildPane() {
  document.body.innerHTML = "";
  const pane = document.createElement("div");
  pane.className = "session-pane";
  pane.innerHTML = `<div class="session-messages"><div class="msg user">hi</div></div>`;
  document.body.appendChild(pane);
  return pane;
}

const stillFrame = () => document.querySelector(".pane-freeze");

describe("freezePane", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  // The bug this exists for: the overlay used to be a child of `pane`, and
  // selectSession reaches `pane.innerHTML = ...` synchronously, so the frame
  // was destroyed before the browser ever painted it - a silent no-op.
  it("survives the pane's innerHTML being wiped", () => {
    const pane = buildPane();
    const thaw = freezePane(pane);
    pane.innerHTML = `<div class="session-messages"></div>`;
    expect(stillFrame()).not.toBeNull();
    expect(stillFrame()?.textContent).toContain("hi");
    thaw();
  });

  it("is not a child of the pane it covers", () => {
    const pane = buildPane();
    const thaw = freezePane(pane);
    expect(pane.contains(stillFrame())).toBe(false);
    thaw();
  });

  it("fades out and removes itself on release", () => {
    vi.useFakeTimers();
    const pane = buildPane();
    freezePane(pane)();
    expect(stillFrame()?.classList.contains("is-fading")).toBe(true);
    vi.runAllTimers();
    expect(stillFrame()).toBeNull();
    vi.useRealTimers();
  });

  it("releases only once", () => {
    vi.useFakeTimers();
    const pane = buildPane();
    const thaw = freezePane(pane);
    thaw();
    vi.runAllTimers();
    thaw();
    expect(stillFrame()).toBeNull();
    vi.useRealTimers();
  });

  it("is a no-op when there is no transcript to freeze", () => {
    document.body.innerHTML = "";
    const pane = document.createElement("div");
    pane.innerHTML = `<div class="session-messages"></div>`;
    document.body.appendChild(pane);
    freezePane(pane)();
    expect(stillFrame()).toBeNull();
  });
});
