// Zoom that lives inside the pushed page, so it behaves the same on a phone
// and a desktop and never zooms the app chrome around the preview. A native
// pinch inside an iframe would scale the WHOLE app, and a desktop webview has
// no page zoom at all, so the page implements its own: two-finger pinch,
// double-tap, Ctrl+wheel (a trackpad pinch arrives as one) and Ctrl +/-/0.
// Scrolling stays native, which is why this uses CSS `zoom` on the root rather
// than a transform around a clipped stage.

/** Runs inside the pushed page, not in the app: it is serialized with
 *  `toString()` into a <script>, so it must reference nothing from this module. */
export function pageZoomRuntime(): void {
  const MIN = 1;
  const MAX = 5;
  const KEY_STEP = 1.2;
  const DOUBLE_TAP_ZOOM = 2.5;
  const DOUBLE_TAP_MS = 320;
  const TAP_SLOP_PX = 12;
  const root = document.documentElement;
  let zoom = 1;

  // pan-x/pan-y is every gesture but pinch, so the browser never starts its
  // own whole-app pinch underneath ours.
  root.style.touchAction = "pan-x pan-y";

  /** Zooms to `next`, keeping the content point under (cx, cy) still. */
  function setZoom(next: number, cx: number, cy: number): void {
    const clamped = Math.min(MAX, Math.max(MIN, next));
    if (clamped === zoom) return;
    const scroller = document.scrollingElement || root;
    const ratio = clamped / zoom;
    const left = (scroller.scrollLeft + cx) * ratio - cx;
    const top = (scroller.scrollTop + cy) * ratio - cy;
    zoom = clamped;
    (root.style as CSSStyleDeclaration & { zoom: string }).zoom = String(zoom);
    scroller.scrollLeft = left;
    scroller.scrollTop = top;
  }

  window.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const delta = Math.max(-40, Math.min(40, e.deltaY));
    setZoom(zoom * Math.exp(-delta * 0.006), e.clientX, e.clientY);
  }, { passive: false });

  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    if (e.key === "=" || e.key === "+") setZoom(zoom * KEY_STEP, cx, cy);
    else if (e.key === "-") setZoom(zoom / KEY_STEP, cx, cy);
    else if (e.key === "0") setZoom(1, cx, cy);
    else return;
    e.preventDefault();
  });

  let pinch: { dist: number; zoom: number } | null = null;
  const spread = (t: TouchList) => Math.hypot(t[1]!.clientX - t[0]!.clientX, t[1]!.clientY - t[0]!.clientY);
  const midX = (t: TouchList) => (t[0]!.clientX + t[1]!.clientX) / 2;
  const midY = (t: TouchList) => (t[0]!.clientY + t[1]!.clientY) / 2;

  let tapStart: { x: number; y: number; at: number } | null = null;
  let lastTap: { x: number; y: number; at: number } | null = null;

  window.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) {
      pinch = { dist: Math.max(1, spread(e.touches)), zoom };
      tapStart = null;
    } else if (e.touches.length === 1) {
      tapStart = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY, at: Date.now() };
    } else {
      tapStart = null;
    }
  }, { passive: true });

  window.addEventListener("touchmove", (e) => {
    if (pinch && e.touches.length === 2) {
      e.preventDefault();
      setZoom(pinch.zoom * (spread(e.touches) / pinch.dist), midX(e.touches), midY(e.touches));
      return;
    }
    const t = e.touches[0];
    if (tapStart && t && Math.hypot(t.clientX - tapStart.x, t.clientY - tapStart.y) > TAP_SLOP_PX) tapStart = null;
  }, { passive: false });

  const endTouch = (e: TouchEvent) => {
    if (e.touches.length < 2) pinch = null;
    if (e.type !== "touchend" || !tapStart || e.touches.length > 0) {
      tapStart = null;
      return;
    }
    const tap = { x: tapStart.x, y: tapStart.y, at: Date.now() };
    tapStart = null;
    if (lastTap && tap.at - lastTap.at < DOUBLE_TAP_MS && Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < TAP_SLOP_PX * 3) {
      lastTap = null;
      setZoom(zoom > 1 ? 1 : DOUBLE_TAP_ZOOM, tap.x, tap.y);
      return;
    }
    lastTap = tap;
  };
  window.addEventListener("touchend", endTouch, { passive: true });
  window.addEventListener("touchcancel", endTouch, { passive: true });
}

export const PAGE_ZOOM_SCRIPT = `<script>(${pageZoomRuntime.toString()})();</script>`;
