import { describe, it, expect, beforeEach } from "vitest";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
};

const { clampPosition, loadPosition, savePosition, clearPosition } =
  await import("../src/views/command-palette/position.ts");

beforeEach(() => store.clear());

const PANEL = { width: 640, height: 400 };
const VIEW = { width: 1359, height: 900 };

describe("clampPosition", () => {
  it("leaves a spot inside the window alone", () => {
    expect(clampPosition({ left: 300, top: 120 }, PANEL, VIEW)).toEqual({ left: 300, top: 120 });
  });

  it("keeps the grip reachable when the window shrank below the saved spot", () => {
    expect(clampPosition({ left: 2000, top: 2000 }, PANEL, { width: 800, height: 500 })).toEqual({ left: 740, top: 440 });
  });

  it("never lets the top edge leave the window, so the grip stays on screen", () => {
    expect(clampPosition({ left: 100, top: -50 }, PANEL, VIEW).top).toBe(0);
  });

  it("lets the panel hang off the left edge but keeps a strip of it visible", () => {
    expect(clampPosition({ left: -9999, top: 10 }, PANEL, VIEW).left).toBe(60 - 640);
  });
});

describe("saved position", () => {
  it("is null until the palette has been moved", () => {
    expect(loadPosition()).toBeNull();
  });

  it("reads back what was saved, and clearing forgets it", () => {
    savePosition({ left: 12, top: 34 });
    expect(loadPosition()).toEqual({ left: 12, top: 34 });
    clearPosition();
    expect(loadPosition()).toBeNull();
  });

  it("reads a corrupt or partial entry as never moved", () => {
    store.set("cc_palette_position", "{oops");
    expect(loadPosition()).toBeNull();
    store.set("cc_palette_position", JSON.stringify({ left: 5 }));
    expect(loadPosition()).toBeNull();
    store.set("cc_palette_position", JSON.stringify({ left: "a", top: 1 }));
    expect(loadPosition()).toBeNull();
  });
});
