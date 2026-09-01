// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { openActionPopover } from "../src/shared/chat/anchored-popover.ts";

describe("openActionPopover arrow-key roving focus", () => {
  let anchor;
  afterEach(() => {
    anchor?.remove();
    document.querySelectorAll(".test-popover").forEach((el) => el.remove());
  });

  function setup() {
    anchor = document.createElement("button");
    document.body.appendChild(anchor);
    const handle = openActionPopover({
      anchor,
      className: "test-popover",
      bodyHtml: `<button class="row">a</button><button class="row">b</button><button class="row">c</button>`,
      buttonSelector: ".row",
      onPick: () => {},
    });
    const buttons = Array.from(document.querySelectorAll(".test-popover .row"));
    return { handle, buttons };
  }

  it("lands ArrowUp on the last row when focus starts outside the button set", () => {
    const { buttons } = setup();
    anchor.focus();
    document.querySelector(".test-popover").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })
    );
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  });

  it("lands ArrowDown on the first row when focus starts outside the button set", () => {
    const { buttons } = setup();
    anchor.focus();
    document.querySelector(".test-popover").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })
    );
    expect(document.activeElement).toBe(buttons[0]);
  });
});
