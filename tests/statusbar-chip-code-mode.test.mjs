// @vitest-environment jsdom

// The standalone branch and ahead/behind chips still render as buttons when a
// statusline row picks them, so each needs its own way into Code mode now that
// the merged git chip opens the commit list instead.

import { describe, it, expect, vi, beforeEach } from "vitest";

const openInCodeMode = vi.fn();
vi.mock("../src/shared/chat/code-mode-bridge.ts", () => ({ openInCodeMode: (t) => openInCodeMode(t) }));

const { wireChipPopovers } = await import("../src/views/sessions/session-statusbar-popovers.ts");

const popover = () => ({ isOpen: false, open: vi.fn(), close: vi.fn(), reanchor: vi.fn() });

function ctx(cwd) {
  return {
    drainPopover: popover(),
    aiTodosPopover: popover(),
    serversPopover: popover(),
    imagesPopover: popover(),
    commitsPopover: popover(),
    effortPopover: popover(),
    modelPopover: popover(),
    overflowPopover: popover(),
    tally: { closePopover: vi.fn() },
    cwd,
    effortAnchor: null,
    modelAnchor: null,
    toggleModelPopover: vi.fn(),
    toggleEffortPopover: vi.fn(),
    overflowData: () => ({}),
  };
}

function bar() {
  const el = document.createElement("div");
  el.innerHTML = '<span class="sb-chip sb-git-btn"></span><span class="sb-chip sb-branch-btn"></span><span class="sb-chip sb-commits-btn"></span>';
  document.body.appendChild(el);
  return el;
}

describe("statusbar git chips", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    openInCodeMode.mockClear();
  });

  for (const sel of [".sb-branch-btn", ".sb-commits-btn"]) {
    it(`${sel} opens Code mode on the unpushed scope with the commits fold open`, () => {
      const el = bar();
      wireChipPopovers(el, ctx("C:\\repo"));
      el.querySelector(sel).click();
      expect(openInCodeMode).toHaveBeenCalledWith({ kind: "scope", scope: "unpushed", commitsOpen: true });
    });
  }

  it("does nothing without a working directory", () => {
    const el = bar();
    wireChipPopovers(el, ctx(null));
    el.querySelector(".sb-commits-btn").click();
    expect(openInCodeMode).not.toHaveBeenCalled();
  });

  it("the merged git chip opens the commit list, not Code mode", () => {
    const el = bar();
    const c = ctx("C:\\repo");
    wireChipPopovers(el, c);
    el.querySelector(".sb-git-btn").click();
    expect(c.commitsPopover.open).toHaveBeenCalledOnce();
    expect(openInCodeMode).not.toHaveBeenCalled();
  });
});
