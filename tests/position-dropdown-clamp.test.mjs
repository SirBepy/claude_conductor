// @vitest-environment jsdom
// asserts: src/views/sessions/position-dropdown.ts
import { describe, it, expect, beforeEach } from "vitest";
import { positionDropdown } from "../src/views/sessions/position-dropdown.ts";

const rect = (o) => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, ...o });

function setup(anchorRect, menuSize) {
  Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
  const anchor = document.createElement("button");
  anchor.getBoundingClientRect = () => rect(anchorRect);
  const menu = document.createElement("div");
  menu.getBoundingClientRect = () => rect(menuSize);
  return { anchor, menu };
}

describe("positionDropdown horizontal clamp", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("right-align stays right-anchored when it fits", () => {
    const { anchor, menu } = setup({ left: 500, right: 540, top: 100, bottom: 130, width: 40, height: 30 }, { width: 200, height: 100 });
    positionDropdown(menu, anchor, { align: "right" });
    expect(menu.style.right).toBe("260px");
    expect(menu.style.left).toBe("");
  });

  it("right-align clamps to the left edge for an anchor hugging it (a chat head)", () => {
    const { anchor, menu } = setup({ left: 0, right: 40, top: 100, bottom: 130, width: 40, height: 30 }, { width: 200, height: 100 });
    positionDropdown(menu, anchor, { align: "right" });
    expect(menu.style.left).toBe("4px");
    expect(menu.style.right).toBe("");
  });

  it("right-align stays right-anchored, held 4px in, for an anchor flush with the right edge", () => {
    const { anchor, menu } = setup({ left: 770, right: 800, top: 100, bottom: 130, width: 30, height: 30 }, { width: 200, height: 100 });
    positionDropdown(menu, anchor, { align: "right" });
    expect(menu.style.right).toBe("4px");
    expect(menu.style.left).toBe("");
  });

  it("left-align clamps to the right edge", () => {
    const { anchor, menu } = setup({ left: 760, right: 790, top: 100, bottom: 130, width: 30, height: 30 }, { width: 200, height: 100 });
    positionDropdown(menu, anchor, { align: "left" });
    expect(menu.style.left).toBe("596px");
  });

  it("a menu wider than the viewport is capped to it", () => {
    const { anchor, menu } = setup({ left: 10, right: 40, top: 100, bottom: 130, width: 30, height: 30 }, { width: 900, height: 100 });
    positionDropdown(menu, anchor, { align: "right" });
    expect(menu.style.maxWidth).toBe("792px");
    expect(menu.style.left).toBe("4px");
  });
});
