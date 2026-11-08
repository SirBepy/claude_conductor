// Where the palette sits once Joe drags it. Persisted so it reopens in the spot
// he chose across relaunches (the whole point of moving it: it can then park
// beside the chat instead of covering the composer every time).

const LS_KEY = "cc_palette_position";

export interface PalettePosition {
  left: number;
  top: number;
}

/** Keeps at least `GRAB` px of the panel on screen on every side, so the grip is
 *  always reachable after a smaller window or a different monitor. */
const GRAB = 60;

export function clampPosition(
  pos: PalettePosition,
  panel: { width: number; height: number },
  view: { width: number; height: number },
): PalettePosition {
  const maxLeft = Math.max(view.width - GRAB, 0);
  const maxTop = Math.max(view.height - GRAB, 0);
  return {
    left: Math.min(Math.max(pos.left, GRAB - panel.width), maxLeft),
    top: Math.min(Math.max(pos.top, 0), maxTop),
  };
}

export function loadPosition(): PalettePosition | null {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) ?? "null");
    if (raw && Number.isFinite(raw.left) && Number.isFinite(raw.top)) return { left: raw.left, top: raw.top };
  } catch { /* corrupt entry reads as never moved */ }
  return null;
}

export function savePosition(pos: PalettePosition): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(pos)); }
  catch { /* storage full or blocked: it reopens centred */ }
}

export function clearPosition(): void {
  try { localStorage.removeItem(LS_KEY); }
  catch { /* nothing to clear */ }
}
