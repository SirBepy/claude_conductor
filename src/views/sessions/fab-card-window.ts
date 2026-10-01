// The FAB card as a window inside the app (Joe, 2026-10-01): centred by
// default, dragged by its spine, resized from any edge or corner, with the
// transcript still live behind it. fab-dial.ts rebuilds the card on every
// render, so this owns only the geometry and re-binds to whatever card is
// current.

export interface CardRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

interface Bounds {
  w: number;
  h: number;
}

const SIZE_KEY = "cc.fabCard.size";
const DEFAULT_SIZE = { w: 620, h: 540 };
const MIN_W = 320;
const MIN_H = 260;
/** Gap kept between the card and the pane edge, so a shadow and a grab
 *  handle stay reachable however far it is dragged. */
const MARGIN = 8;
/** Same breakpoint as sessions-mobile.css: on a phone the card stays the
 *  full-width sheet fab-dial.css lays out, with no drag or resize. */
const COMPACT_QUERY = "(max-width: 768px)";
const DIRS: ResizeDir[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

/** Keeps a rect inside the pane, shrinking it first when the pane itself got
 *  smaller than the card. */
export function clampRect(r: CardRect, b: Bounds): CardRect {
  const maxW = Math.max(MIN_W, b.w - MARGIN * 2);
  const maxH = Math.max(MIN_H, b.h - MARGIN * 2);
  const w = Math.min(Math.max(r.w, MIN_W), maxW);
  const h = Math.min(Math.max(r.h, MIN_H), maxH);
  const x = Math.min(Math.max(r.x, MARGIN), Math.max(MARGIN, b.w - MARGIN - w));
  const y = Math.min(Math.max(r.y, MARGIN), Math.max(MARGIN, b.h - MARGIN - h));
  return { x, y, w, h };
}

export function centredRect(size: { w: number; h: number }, b: Bounds): CardRect {
  return clampRect({ x: (b.w - size.w) / 2, y: (b.h - size.h) / 2, w: size.w, h: size.h }, b);
}

/** Moves only the edges named in `dir`; the opposite edge stays pinned even
 *  when the minimum size stops the drag. */
export function resizeRect(start: CardRect, dir: ResizeDir, dx: number, dy: number, b: Bounds): CardRect {
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

/** Size outlives the app so a preferred editing size sticks across restarts;
 *  position does not, so a fresh launch always opens centred. */
function loadSize(): { w: number; h: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "null");
    if (raw && Number.isFinite(raw.w) && Number.isFinite(raw.h)) return { w: raw.w, h: raw.h };
  } catch {
    /* corrupt entry: fall through to the default */
  }
  return DEFAULT_SIZE;
}

function saveSize(r: CardRect): void {
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify({ w: Math.round(r.w), h: Math.round(r.h) }));
  } catch {
    /* quota or disabled storage: the size just won't persist */
  }
}

type Gesture = { kind: "move" } | { kind: "resize"; dir: ResizeDir };

export class CardWindow {
  private host: HTMLElement;
  private card: HTMLElement | null = null;
  /** null until the first gesture, meaning "centred at the stored size". */
  private rect: CardRect | null = null;
  private obs: ResizeObserver | null = null;
  private onCommit: (rect: CardRect) => void;

  /** `onCommit` fires once per finished drag or resize, never per frame. */
  constructor(host: HTMLElement, onCommit: (rect: CardRect) => void = () => {}) {
    this.host = host;
    this.onCommit = onCommit;
    if (typeof ResizeObserver !== "undefined") {
      this.obs = new ResizeObserver(() => this.apply());
      this.obs.observe(host);
    }
  }

  /** Called after every render that produced a card. */
  bind(card: HTMLElement): void {
    this.card = card;
    card.insertAdjacentHTML(
      "beforeend",
      DIRS.map((d) => `<span class="fab-rz fab-rz-${d}" data-rz="${d}" aria-hidden="true"></span>`).join(""),
    );
    card.addEventListener("pointerdown", this.onPointerDown);
    this.apply();
  }

  getRect(): CardRect | null {
    return this.rect;
  }

  /** null re-centres at the stored size. Applied on the next bind. */
  setRect(rect: CardRect | null): void {
    this.rect = rect;
  }

  destroy(): void {
    this.obs?.disconnect();
    this.obs = null;
    this.card = null;
  }

  private bounds(): Bounds {
    const box = this.host.getBoundingClientRect();
    return { w: box.width, h: box.height };
  }

  private compact(): boolean {
    return typeof window.matchMedia === "function" && window.matchMedia(COMPACT_QUERY).matches;
  }

  private current(b: Bounds): CardRect {
    return this.rect ? clampRect(this.rect, b) : centredRect(loadSize(), b);
  }

  private apply(): void {
    const card = this.card;
    if (!card || !card.isConnected) return;
    const b = this.bounds();
    // An unlaid-out host (hidden pane, jsdom) has no size to centre in.
    if (this.compact() || b.w === 0 || b.h === 0) {
      card.removeAttribute("style");
      return;
    }
    this.paint(card, this.current(b));
  }

  private paint(card: HTMLElement, r: CardRect): void {
    Object.assign(card.style, {
      left: `${Math.round(r.x)}px`,
      top: `${Math.round(r.y)}px`,
      width: `${Math.round(r.w)}px`,
      height: `${Math.round(r.h)}px`,
      right: "auto",
      bottom: "auto",
      maxWidth: "none",
      maxHeight: "none",
    });
  }

  private onPointerDown = (ev: PointerEvent): void => {
    if (ev.button !== 0 || this.compact()) return;
    const el = ev.target as HTMLElement;
    const rz = el.closest<HTMLElement>("[data-rz]");
    // The spine is the title bar: any of it drags except its buttons.
    const onSpine = !!el.closest(".fab-spine") && !el.closest("button");
    let gesture: Gesture;
    if (rz) gesture = { kind: "resize", dir: rz.dataset.rz as ResizeDir };
    else if (onSpine) gesture = { kind: "move" };
    else return;

    const card = this.card;
    if (!card) return;
    ev.preventDefault();
    const b = this.bounds();
    const start = this.current(b);
    const sx = ev.clientX;
    const sy = ev.clientY;
    const target = ev.target as Element;
    target.setPointerCapture?.(ev.pointerId);
    card.classList.add(gesture.kind === "move" ? "is-moving" : "is-resizing");
    rz?.classList.add("is-active");

    const move = (e: PointerEvent): void => {
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      this.rect =
        gesture.kind === "move"
          ? clampRect({ ...start, x: start.x + dx, y: start.y + dy }, b)
          : resizeRect(start, gesture.dir, dx, dy, b);
      this.paint(card, this.rect);
    };
    const up = (e: PointerEvent): void => {
      target.releasePointerCapture?.(e.pointerId);
      target.removeEventListener("pointermove", move as EventListener);
      target.removeEventListener("pointerup", up as EventListener);
      target.removeEventListener("pointercancel", up as EventListener);
      card.classList.remove("is-moving", "is-resizing");
      rz?.classList.remove("is-active");
      if (!this.rect) return;
      if (gesture.kind === "resize") saveSize(this.rect);
      this.onCommit(this.rect);
    };
    target.addEventListener("pointermove", move as EventListener);
    target.addEventListener("pointerup", up as EventListener);
    target.addEventListener("pointercancel", up as EventListener);
  };
}
