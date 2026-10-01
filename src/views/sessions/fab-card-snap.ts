// Snap zones for the floating FAB card (Joe, 2026-10-01): drag it into a
// corner of the pane and it becomes a small window in that corner; drag it to
// the left or right edge and it becomes a full-height column, not too wide.
// Pure geometry - fab-card-window.ts owns the drag, the preview and the drop.

export type SnapZone = "nw" | "ne" | "sw" | "se" | "w" | "e";

export interface SnapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Bounds {
  w: number;
  h: number;
}

/** How close the POINTER (not the card) must get to a pane edge to arm a snap. */
const EDGE = 28;
/** Along an edge, this share of the pane next to a corner counts as the corner,
 *  so aiming for a corner does not need pixel precision. */
const CORNER_REACH = 0.22;

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

export function snapZoneAt(px: number, py: number, b: Bounds): SnapZone | null {
  const nearL = px <= EDGE;
  const nearR = px >= b.w - EDGE;
  const nearT = py <= EDGE;
  const nearB = py >= b.h - EDGE;
  const topBand = py <= b.h * CORNER_REACH;
  const bottomBand = py >= b.h * (1 - CORNER_REACH);
  const leftBand = px <= b.w * CORNER_REACH;
  const rightBand = px >= b.w * (1 - CORNER_REACH);
  if ((nearL && topBand) || (nearT && leftBand)) return "nw";
  if ((nearR && topBand) || (nearT && rightBand)) return "ne";
  if ((nearL && bottomBand) || (nearB && leftBand)) return "sw";
  if ((nearR && bottomBand) || (nearB && rightBand)) return "se";
  if (nearL) return "w";
  if (nearR) return "e";
  return null;
}

/** Where a zone puts the card. Unclamped: the caller fits it to the pane. */
export function snapRect(zone: SnapZone, b: Bounds, margin: number): SnapRect {
  const side = zone === "w" || zone === "e";
  const w = clamp(b.w * 0.34, 360, side ? 480 : 460);
  const h = side ? b.h - margin * 2 : clamp(b.h * 0.48, 300, 440);
  const x = zone.includes("w") ? margin : b.w - margin - w;
  const y = side || zone.includes("n") ? margin : b.h - margin - h;
  return { x, y, w, h };
}
