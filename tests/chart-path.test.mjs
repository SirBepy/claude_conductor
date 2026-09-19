import { describe, it, expect } from "vitest";
import { buildSmoothPath } from "../src/views/dashboard/widgets/chart-path.ts";

// px-space replica of the weekly-chart bug report: a long flat run, then a
// big jump between two nearly-coincident X points near the right edge. The
// old Catmull-Rom /6 control points overshot past the tiny segment here and
// the path doubled back in X (visible loop next to Sat 9/19).
const sharpJump = [
  { x: 30, y: 150 },
  { x: 85, y: 145 },
  { x: 140, y: 140 },
  { x: 195, y: 138 },
  { x: 250, y: 136 },
  { x: 330, y: 135 },
  { x: 355, y: 133 },
  { x: 357, y: 60 },
  { x: 360, y: 55 },
  { x: 412, y: 52 },
];

function coords(d) {
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const pts = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
  return pts;
}

describe("buildSmoothPath", () => {
  it("path X never decreases on the sharp-jump fixture", () => {
    const pts = coords(buildSmoothPath(sharpJump));
    expect(pts.length).toBeGreaterThan(sharpJump.length);
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i].x, `x went backwards at coord ${i}: ${pts[i - 1].x} -> ${pts[i].x}`)
        .toBeGreaterThanOrEqual(pts[i - 1].x);
    }
  });

  it("keeps control-point X inside each segment for random uneven spacing", () => {
    let x = 0;
    const pts = [];
    for (let i = 0; i < 40; i++) {
      x += i % 7 === 3 ? 0.5 : 10 + (i * 13) % 57;
      pts.push({ x, y: (i * 37) % 100 });
    }
    const out = coords(buildSmoothPath(pts));
    for (let i = 1; i < out.length; i++) {
      expect(out[i].x).toBeGreaterThanOrEqual(out[i - 1].x);
    }
  });

  it("passes through every input point", () => {
    const d = buildSmoothPath(sharpJump);
    for (const p of sharpJump) {
      expect(d).toContain(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
    }
  });

  it("does not overshoot Y beyond the data range on monotone data", () => {
    const rising = [
      { x: 0, y: 0 }, { x: 10, y: 5 }, { x: 12, y: 80 }, { x: 100, y: 82 }, { x: 110, y: 90 },
    ];
    const pts = coords(buildSmoothPath(rising));
    for (const p of pts) {
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(90);
    }
  });

  it("handles degenerate inputs", () => {
    expect(buildSmoothPath([])).toBe("");
    expect(buildSmoothPath([{ x: 5, y: 6 }])).toBe("M5.0,6.0");
    expect(buildSmoothPath([{ x: 5, y: 6 }, { x: 9, y: 2 }])).toBe("M5.0,6.0 L9.0,2.0");
  });

  it("emits no NaN for duplicate-x points", () => {
    const d = buildSmoothPath([
      { x: 10, y: 10 }, { x: 10, y: 40 }, { x: 10, y: 20 }, { x: 50, y: 30 },
    ]);
    expect(d).not.toContain("NaN");
  });
});
