// Cursor-anchored zoom (scroll wheel, continuous; or a plain click, toggling
// between fit and a fixed zoomed-in level) + drag-to-pan for an <img> inside
// a fixed-size container. Shared by lightbox.ts (single-image view) and
// chat-image-gallery.ts (multi-image view) - same interaction on both.
//
// The container must be sized to the actual viewing area (not shrunk to the
// image's own pre-transform size) and have `overflow: hidden` - otherwise a
// zoomed-in image gets clipped at its own original box instead of the real
// viewing area (see the `.lightbox-content--image` CSS fix in chat-overlays.css
// and its `.screenshot-gallery-stage` twin in chat-image-gallery.css).

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const CLICK_ZOOM_SCALE = 2.5;
const DRAG_THRESHOLD_PX = 6;
const ZOOM_ANIM_MS = 220;
/** Extra pan allowance past the point where the image's edge reaches the
 *  container's edge, as a fraction of the container's own size - so panning
 *  toward a corner can overshoot into blank space a bit instead of hard-
 *  stopping exactly at the edge. */
const OVERPAN_FRACTION = 0.35;

/** Returns a cleanup function that removes the container-level wheel
 *  listener - required whenever `container` is REUSED across multiple images
 *  (e.g. the screenshot gallery's `stage`, which persists across prev/next
 *  navigation instead of getting recreated per image like the lightbox's
 *  `inner` does) - otherwise each new image stacks another wheel listener on
 *  top of the container instead of replacing it. */
export function setupImageZoomPan(img: HTMLImageElement, container: HTMLElement): () => void {
  let scale = 1;
  let tx = 0;
  let ty = 0;

  /** `animated` plays a short transition - only for the discrete click-toggle
   *  jump. Wheel-zoom and drag-pan stay instant/1:1 (a transition there would
   *  lag behind the input instead of tracking it continuously). */
  function apply(animated = false): void {
    img.style.transition = animated ? `transform ${ZOOM_ANIM_MS}ms ease` : "none";
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    img.style.cursor = scale > MIN_SCALE ? "grab" : "zoom-in";
  }

  function clampPan(): void {
    const baseW = img.offsetWidth;
    const baseH = img.offsetHeight;
    const containerRect = container.getBoundingClientRect();
    const overflowX = Math.max(0, (baseW * scale - containerRect.width) / 2) + containerRect.width * OVERPAN_FRACTION;
    const overflowY = Math.max(0, (baseH * scale - containerRect.height) / 2) + containerRect.height * OVERPAN_FRACTION;
    tx = Math.min(overflowX, Math.max(-overflowX, tx));
    ty = Math.min(overflowY, Math.max(-overflowY, ty));
  }

  /** Zoom to `targetScale`, keeping the point under (clientX, clientY) fixed
   *  on screen. Shared by wheel-zoom and click-toggle-zoom. */
  function zoomAt(clientX: number, clientY: number, targetScale: number, animated = false): void {
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, targetScale));
    const r = newScale / scale;
    if (r === 1) return;
    const containerRect = container.getBoundingClientRect();
    const ccx = containerRect.left + containerRect.width / 2;
    const ccy = containerRect.top + containerRect.height / 2;
    tx = tx * r + (clientX - ccx) * (1 - r);
    ty = ty * r + (clientY - ccy) * (1 - r);
    scale = newScale;
    if (scale === MIN_SCALE) { tx = 0; ty = 0; }
    clampPan();
    apply(animated);
  }

  img.style.transformOrigin = "center center";
  // Promote to its own GPU compositing layer so transform updates during a
  // fast drag are pure GPU work, not a CPU repaint of the overflow:hidden-
  // clipped region each frame - without this, a fast pan can outrun the
  // repaint and leave stale striped/torn pixels behind.
  img.style.willChange = "transform";
  // Browsers make <img> natively draggable (HTML5 drag-and-drop) - without
  // disabling that, a pointerdown+move on the image starts a native OS-level
  // drag-ghost operation that hijacks the event stream instead of delivering
  // continuous pointermove events, which is why panning felt like a single
  // "nudge" rather than tracking the cursor.
  img.draggable = false;
  img.style.setProperty("-webkit-user-drag", "none");
  img.style.userSelect = "none";
  apply();

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    zoomAt(e.clientX, e.clientY, scale * factor);
  };
  container.addEventListener("wheel", onWheel, { passive: false });

  let dragging = false;
  let dragged = false;
  let startX = 0;
  let startY = 0;
  let startTx = 0;
  let startTy = 0;

  img.addEventListener("pointerdown", (e) => {
    dragging = true;
    dragged = false;
    startX = e.clientX;
    startY = e.clientY;
    startTx = tx;
    startTy = ty;
    img.setPointerCapture(e.pointerId);
  });
  img.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!dragged && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
      dragged = true;
      img.style.cursor = "grabbing";
    }
    if (dragged) {
      tx = startTx + dx;
      ty = startTy + dy;
      clampPan();
      apply();
    }
  });
  function endDrag(e: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    if (!dragged) {
      // A click, not a drag: toggle between fit and a fixed zoomed-in level,
      // animated - zoomAt() already calls apply(true) internally.
      zoomAt(e.clientX, e.clientY, scale <= MIN_SCALE ? CLICK_ZOOM_SCALE : MIN_SCALE, true);
    } else {
      apply(); // just restore the cursor after a drag-pan ends
    }
  }
  img.addEventListener("pointerup", endDrag);
  img.addEventListener("pointercancel", () => { dragging = false; });

  return () => container.removeEventListener("wheel", onWheel);
}
