// Monotone-in-X cubic smoothing (Fritsch-Carlson tangents, curveMonotoneX
// style). Control points stay inside each segment's X span, so the smoothed
// path can never double back in X on unevenly spaced points.

export interface PathPoint { x: number; y: number }

const sign = (v: number): number => (v < 0 ? -1 : 1);

// Tangent at the middle of three points; 0 at local extrema so the curve
// never overshoots past a data point's Y.
function innerTangent(p0: PathPoint, p1: PathPoint, p2: PathPoint): number {
  const h0 = p1.x - p0.x;
  const h1 = p2.x - p1.x;
  const s0 = h0 ? (p1.y - p0.y) / h0 : 0;
  const s1 = h1 ? (p2.y - p1.y) / h1 : 0;
  const p = (s0 * h1 + s1 * h0) / (h0 + h1);
  const m = (sign(s0) + sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p));
  return Number.isFinite(m) ? m : 0;
}

// One-sided endpoint tangent given the adjacent interior tangent.
function edgeTangent(a: PathPoint, b: PathPoint, t: number): number {
  const h = b.x - a.x;
  return h ? (3 * ((b.y - a.y) / h) - t) / 2 : t;
}

/** Points must be sorted by ascending x (equal x allowed). */
export function buildSmoothPath(pts: PathPoint[]): string {
  if (pts.length === 0) return "";
  let d = `M${pts[0]!.x.toFixed(1)},${pts[0]!.y.toFixed(1)}`;
  if (pts.length === 1) return d;
  if (pts.length === 2) return d + ` L${pts[1]!.x.toFixed(1)},${pts[1]!.y.toFixed(1)}`;

  const n = pts.length;
  const m = new Array<number>(n);
  for (let i = 1; i < n - 1; i++) m[i] = innerTangent(pts[i - 1]!, pts[i]!, pts[i + 1]!);
  m[0] = edgeTangent(pts[0]!, pts[1]!, m[1]!);
  m[n - 1] = edgeTangent(pts[n - 2]!, pts[n - 1]!, m[n - 2]!);

  for (let i = 0; i < n - 1; i++) {
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const dx = (p2.x - p1.x) / 3;
    d +=
      ` C${(p1.x + dx).toFixed(1)},${(p1.y + m[i]! * dx).toFixed(1)}` +
      ` ${(p2.x - dx).toFixed(1)},${(p2.y - m[i + 1]! * dx).toFixed(1)}` +
      ` ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}
