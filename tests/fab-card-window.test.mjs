// @vitest-environment jsdom
//
// The FAB card is a window inside the pane: centred by default, dragged by its
// spine, resized from any edge or corner, never pushed out of the pane.

import { describe, it, expect, beforeEach } from "vitest";

const { clampRect, centredRect, resizeRect, CardWindow } = await import("../src/views/sessions/fab-card-window.ts");

const PANE = { w: 1200, h: 800 };

describe("fab card geometry", () => {
  it("centres the stored size in the pane", () => {
    expect(centredRect({ w: 600, h: 500 }, PANE)).toEqual({ x: 300, y: 150, w: 600, h: 500 });
  });

  it("shrinks a card bigger than the pane to fit inside the margin", () => {
    expect(centredRect({ w: 2000, h: 2000 }, PANE)).toEqual({ x: 8, y: 8, w: 1184, h: 784 });
  });

  it("keeps a dragged card inside the pane", () => {
    expect(clampRect({ x: -500, y: 5000, w: 600, h: 500 }, PANE)).toEqual({ x: 8, y: 292, w: 600, h: 500 });
  });

  it("resizes from the top-left corner with the bottom-right edge pinned", () => {
    const start = { x: 300, y: 150, w: 600, h: 500 };
    expect(resizeRect(start, "nw", -100, -50, PANE)).toEqual({ x: 200, y: 100, w: 700, h: 550 });
  });

  it("stops at the minimum size without moving the pinned edge", () => {
    const start = { x: 300, y: 150, w: 600, h: 500 };
    const r = resizeRect(start, "w", 1000, 0, PANE);
    expect(r.x + r.w).toBe(900);
    expect(r.w).toBe(320);
  });

  it("never resizes past the pane edge", () => {
    const start = { x: 300, y: 150, w: 600, h: 500 };
    expect(resizeRect(start, "se", 5000, 5000, PANE)).toEqual({ x: 300, y: 150, w: 892, h: 642 });
  });
});

describe("CardWindow.bind", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("adds a grab strip for every edge and corner", () => {
    const host = document.createElement("div");
    const card = document.createElement("div");
    host.appendChild(card);
    document.body.appendChild(host);
    new CardWindow(host).bind(card);
    const dirs = [...card.querySelectorAll("[data-rz]")].map((el) => el.dataset.rz).sort();
    expect(dirs).toEqual(["e", "n", "ne", "nw", "s", "se", "sw", "w"]);
  });
});
