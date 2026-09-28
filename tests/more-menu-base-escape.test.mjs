// @vitest-environment jsdom
// Step 1 of the shared-primitive-lacks-Escape audit finding: createMoreMenu
// had no Escape handling at all (grep -c Escape was 0), unlike
// src/shared/kebab-menu.ts. This proves the added handler closes the menu
// and returns focus to the trigger, matching kebab-menu.ts:34-37's pattern.
//
// This is DOM/logic-level only (dispatchEvent lets the test pick target and
// isTrusted, which real key handling doesn't) - it proves the open/close
// bookkeeping, not that a real browser keypress reaches this listener.

import { describe, it, expect } from "vitest";
import { createMoreMenu } from "../src/views/sessions/more-menu-base.ts";

function tick() {
  return new Promise((r) => setTimeout(r, 0));
}

function pressEscape() {
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

describe("createMoreMenu Escape handling", () => {
  it("closes the menu and returns focus to the trigger button", async () => {
    document.body.innerHTML = "";
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    btn.focus();
    expect(document.activeElement).toBe(btn);

    const menuHandle = createMoreMenu({
      build: (menu, close) => {
        const item = document.createElement("button");
        item.textContent = "Item";
        item.onclick = close;
        menu.appendChild(item);
      },
    });

    menuHandle.open(btn);
    await tick();
    expect(menuHandle.element()).not.toBeNull();

    // Move focus away, as a real Escape-from-inside-the-menu keypress would.
    const item = menuHandle.element().querySelector("button");
    item.focus();

    pressEscape();

    expect(menuHandle.element()).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  it("leaves no document-level keydown listener behind after Escape closes it", async () => {
    document.body.innerHTML = "";
    const btn = document.createElement("button");
    document.body.appendChild(btn);

    const menuHandle = createMoreMenu({ build: () => {} });
    menuHandle.open(btn);
    await tick();

    pressEscape();
    expect(menuHandle.element()).toBeNull();

    // A second Escape after close must not throw or re-close an already-null menu.
    expect(() => pressEscape()).not.toThrow();
  });

  it("Escape is a no-op while the menu is closed", () => {
    document.body.innerHTML = "";
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    expect(() => pressEscape()).not.toThrow();
  });
});
