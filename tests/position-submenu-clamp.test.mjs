// @vitest-environment jsdom
// asserts: src/views/sessions/position-dropdown.ts
import { describe, it, expect } from "vitest";
import { positionSubmenu } from "../src/views/sessions/position-dropdown.ts";

const rect = (o) => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, ...o });

describe("positionSubmenu", () => {
  it("clamps to the left viewport edge when neither side has room", () => {
    Object.defineProperty(window, "innerWidth", { value: 400, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    const parent = document.createElement("button");
    parent.getBoundingClientRect = () => rect({ left: 100, right: 380, top: 100 });
    const sub = document.createElement("div");
    sub.getBoundingClientRect = () => rect({ width: 300, height: 200 });
    positionSubmenu(sub, parent);
    expect(sub.style.left).toBe("4px");
    expect(sub.style.maxWidth).toBe("392px");
  });
});
