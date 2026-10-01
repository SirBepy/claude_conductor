// Pane-window geometry: clamping, resizing, the drop zones a dragged window
// or torn-off tab can land in, and how wide a docked split is. Pure.

import type { Corner, DockSide, PaneLayout, Rect } from "./layout";

export type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export interface Bounds {
  w: number;
  h: number;
}

/** Where a drop lands: a corner window, or a docked side. */
export type DropZone = { kind: "snap"; corner: Corner } | { kind: "dock"; side: DockSide };

export const MIN_W = 320;
export const MIN_H = 260;
/** A stacked dock window keeps at least its bar and a few lines of body. */
export const MIN_STACK_H = 140;
/** Gap kept between a floating window and the pane edge, so a shadow and a
 *  grab strip stay reachable however far it is dragged. */
export const MARGIN = 8;
/** The chat keeps at least this much width however wide the docks get. */
export const MIN_CHAT = 360;
const DEFAULT_SIZE = { w: 620, h: 540 };
const SIZE_KEY = "cc.fabCard.size";
/** How close the POINTER must get to a pane edge to arm a drop zone. */
const EDGE = 28;
/** Along an edge, this share of the pane next to a corner counts as the
 *  corner, so aiming for one does not need pixel precision. */
const CORNER_REACH = 0.22;

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** Keeps a rect inside the pane, shrinking it first when the pane itself got
 *  smaller than the window. */
export function clampRect(r: Rect, b: Bounds): Rect {
  const maxW = Math.max(MIN_W, b.w - MARGIN * 2);
  const maxH = Math.max(MIN_H, b.h - MARGIN * 2);
  const w = clamp(r.w, MIN_W, maxW);
  const h = clamp(r.h, MIN_H, maxH);
  const x = clamp(r.x, MARGIN, Math.max(MARGIN, b.w - MARGIN - w));
  const y = clamp(r.y, MARGIN, Math.max(MARGIN, b.h - MARGIN - h));
  return { x, y, w, h };
}

export function centredRect(size: { w: number; h: number }, b: Bounds): Rect {
  return clampRect({ x: (b.w - size.w) / 2, y: (b.h - size.h) / 2, w: size.w, h: size.h }, b);
}

/** Moves only the edges named in `dir`; the opposite edge stays pinned even
 *  when the minimum size stops the drag. */
export function resizeRect(start: Rect, dir: ResizeDir, dx: number, dy: number, b: Bounds): Rect {
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  if (dir.includes("w")) left = Math.min(Math.max(MARGIN, left + dx), right - MIN_W);
  if (dir.includes("e")) right = Math.max(Math.min(b.w - MARGIN, right + dx), left + MIN_W);
  if (dir.includes("n")) top = Math.min(Math.max(MARGIN, top + dy), bottom - MIN_H);
  if (dir.includes("s")) bottom = Math.max(Math.min(b.h - MARGIN, bottom + dy), top + MIN_H);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

export function dropZoneAt(px: number, py: number, b: Bounds): DropZone | null {
  const nearL = px <= EDGE;
  const nearR = px >= b.w - EDGE;
  const nearT = py <= EDGE;
  const nearB = py >= b.h - EDGE;
  const topBand = py <= b.h * CORNER_REACH;
  const bottomBand = py >= b.h * (1 - CORNER_REACH);
  const leftBand = px <= b.w * CORNER_REACH;
  const rightBand = px >= b.w * (1 - CORNER_REACH);
  const snap = (corner: Corner): DropZone => ({ kind: "snap", corner });
  if ((nearL && topBand) || (nearT && leftBand)) return snap("nw");
  if ((nearR && topBand) || (nearT && rightBand)) return snap("ne");
  if ((nearL && bottomBand) || (nearB && leftBand)) return snap("sw");
  if ((nearR && bottomBand) || (nearB && rightBand)) return snap("se");
  if (nearL) return { kind: "dock", side: "left" };
  if (nearR) return { kind: "dock", side: "right" };
  return null;
}

/** A corner window: about a third of the pane wide, under half its height. */
export function cornerRect(corner: Corner, b: Bounds): Rect {
  const w = clamp(b.w * 0.34, MIN_W, 460);
  const h = clamp(b.h * 0.48, 300, 440);
  const x = corner.includes("w") ? MARGIN : b.w - MARGIN - w;
  const y = corner.includes("n") ? MARGIN : b.h - MARGIN - h;
  return clampRect({ x, y, w, h }, b);
}

/** Both docks' widths in px for the pane's FULL width. Default 40% each side;
 *  a dragged share is kept, then both are squeezed so the chat never drops
 *  under MIN_CHAT, and neither dock under MIN_W. */
export function dockWidths(
  paneW: number,
  docked: { left: boolean; right: boolean },
  share: PaneLayout["dockShare"],
): { left: number; right: number } {
  const want = (on: boolean, s: number | null) => (on ? Math.max(MIN_W, paneW * (s ?? 0.4)) : 0);
  let left = want(docked.left, share.left);
  let right = want(docked.right, share.right);
  const room = paneW - MIN_CHAT;
  const over = left + right - room;
  if (over > 0) {
    const total = left + right;
    left = docked.left ? Math.max(MIN_W, left - (over * left) / total) : 0;
    right = docked.right ? Math.max(MIN_W, right - (over * right) / total) : 0;
  }
  return { left: Math.round(left), right: Math.round(right) };
}

/** Where a docked window sits inside the pane-sized host. */
export function dockRect(side: DockSide, width: number, b: Bounds): Rect {
  return { x: side === "left" ? 0 : b.w - width, y: 0, w: width, h: b.h };
}

/** A side's stacked windows, top to bottom, each as tall as its weight's
 *  share of the side; edges are rounded so neighbours meet without a gap. */
export function stackRects(side: DockSide, width: number, b: Bounds, weights: readonly number[]): Rect[] {
  const x = side === "left" ? 0 : b.w - width;
  const total = weights.reduce((n, w) => n + w, 0) || 1;
  let acc = 0;
  return weights.map((wt) => {
    const top = Math.round((acc / total) * b.h);
    acc += wt;
    const bottom = Math.round((acc / total) * b.h);
    return { x, y: top, w: width, h: bottom - top };
  });
}

/** Where a float/snap/dock drop would put a window - what the landing
 *  preview outlines. */
export function zoneRect(zone: DropZone, b: Bounds, dockW: number): Rect {
  return zone.kind === "snap" ? cornerRect(zone.corner, b) : dockRect(zone.side, dockW, b);
}

/** Size outlives the app so a preferred floating size sticks across
 *  restarts; position is per chat, in the layout. */
export function loadSize(): { w: number; h: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "null");
    if (raw && Number.isFinite(raw.w) && Number.isFinite(raw.h)) return { w: raw.w, h: raw.h };
  } catch {
    /* corrupt entry: fall through to the default */
  }
  return DEFAULT_SIZE;
}

export function saveSize(r: Rect): void {
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify({ w: Math.round(r.w), h: Math.round(r.h) }));
  } catch {
    /* quota or disabled storage: the size just won't persist */
  }
}
