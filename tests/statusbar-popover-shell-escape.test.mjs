// @vitest-environment jsdom
// Step 1 of the shared-primitive-lacks-Escape audit finding: PopoverShell had
// no Escape handling at all (grep -c Escape was 0), unlike
// src/shared/kebab-menu.ts. This proves the added handler closes the popover
// and returns focus to the anchor chip, matching kebab-menu.ts:34-37's pattern.
//
// This is DOM/logic-level only (dispatchEvent lets the test pick target and
// isTrusted, which real key handling doesn't) - it proves the open/close
// bookkeeping, not that a real browser keypress reaches this listener.

import { describe, it, expect } from "vitest";
import { PopoverShell } from "../src/views/sessions/statusbar-popover-shell.ts";

function tick() {
  return new Promise((r) => setTimeout(r, 0));
}

function pressEscape() {
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

describe("PopoverShell Escape handling", () => {
  it("closes the popover and returns focus to the anchor chip", async () => {
    document.body.innerHTML = "";
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    anchor.focus();
    expect(document.activeElement).toBe(anchor);

    const shell = new PopoverShell();
    shell.open(anchor, "<div>content</div>");
    await tick();
    expect(shell.isOpen).toBe(true);

    pressEscape();

    expect(shell.isOpen).toBe(false);
    expect(document.activeElement).toBe(anchor);
  });

  it("fires onClose when Escape closes it", async () => {
    document.body.innerHTML = "";
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);

    const shell = new PopoverShell();
    let closed = false;
    shell.open(anchor, "<div>content</div>", { onClose: () => { closed = true; } });
    await tick();

    pressEscape();

    expect(shell.isOpen).toBe(false);
    expect(closed).toBe(true);
  });

  it("Escape is a no-op while the popover is closed", () => {
    document.body.innerHTML = "";
    expect(() => pressEscape()).not.toThrow();
  });
});
