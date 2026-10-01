// Snap zones for the floating FAB card: a corner makes a small window in that
// corner, the left/right edge makes a full-height column that is not too wide.

import { describe, it, expect } from "vitest";

const { snapZoneAt, snapRect } = await import("../src/views/sessions/fab-card-snap.ts");

const PANE = { w: 1200, h: 800 };

describe("snapZoneAt", () => {
  it("arms a corner from either edge near it", () => {
    expect(snapZoneAt(1195, 790, PANE)).toBe("se");
    expect(snapZoneAt(1195, 700, PANE)).toBe("se");
    expect(snapZoneAt(1100, 795, PANE)).toBe("se");
    expect(snapZoneAt(5, 5, PANE)).toBe("nw");
    expect(snapZoneAt(1190, 40, PANE)).toBe("ne");
    expect(snapZoneAt(10, 760, PANE)).toBe("sw");
  });

  it("arms a side column in the middle of the left or right edge", () => {
    expect(snapZoneAt(4, 400, PANE)).toBe("w");
    expect(snapZoneAt(1199, 400, PANE)).toBe("e");
  });

  it("counts a pointer dragged past the pane as at the edge", () => {
    expect(snapZoneAt(-40, 400, PANE)).toBe("w");
  });

  it("stays unarmed away from the edges and mid-way along top or bottom", () => {
    expect(snapZoneAt(600, 400, PANE)).toBeNull();
    expect(snapZoneAt(600, 4, PANE)).toBeNull();
    expect(snapZoneAt(600, 798, PANE)).toBeNull();
  });
});

describe("snapRect", () => {
  it("puts a corner window in its corner, inside the margin", () => {
    const r = snapRect("se", PANE, 8);
    expect(r.x + r.w).toBe(1192);
    expect(r.y + r.h).toBe(792);
    expect(r.w).toBeLessThan(PANE.w / 2);
    expect(r.h).toBeLessThan(PANE.h / 2 + 50);
  });

  it("makes a side column full height but narrow", () => {
    const r = snapRect("w", PANE, 8);
    expect(r).toMatchObject({ x: 8, y: 8, h: 784 });
    expect(r.w).toBeLessThanOrEqual(480);
    const e = snapRect("e", PANE, 8);
    expect(e.x + e.w).toBe(1192);
  });
});
