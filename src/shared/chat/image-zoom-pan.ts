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

  // Every live pointer, so two fingers pinch instead of the second one
  // re-anchoring a one-finger pan mid-gesture.
  const pointers = new Map<number, { x: number; y: number }>();
  // A gesture that pinched or panned must not end as a tap: neither the
  // zoom toggle on the img nor the hosts' click-outside-to-close on the
  // container. Cleared when the next gesture starts.
  let suppressClick = false;
  let panning = false; // a one-finger/mouse drag that started on the img
  let dragged = false;
  let startX = 0;
  let startY = 0;
  let startTx = 0;
  let startTy = 0;
  let pinchStartDist = 0;
  let pinchStartScale = 1;
  let pinchStartMidX = 0;
  let pinchStartMidY = 0;

  function beginPan(x: number, y: number): void {
    startX = x;
    startY = y;
    startTx = tx;
    startTy = ty;
  }

  function pinchPair(): [{ x: number; y: number }, { x: number; y: number }] {
    const [a, b] = [...pointers.values()];
    return [a!, b!];
  }

  function beginPinch(): void {
    const [a, b] = pinchPair();
    pinchStartDist = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
    pinchStartScale = scale;
    pinchStartMidX = (a.x + b.x) / 2;
    pinchStartMidY = (a.y + b.y) / 2;
    startTx = tx;
    startTy = ty;
  }

  /** Scale by the finger spread, keeping the image point that sat under the
   *  starting midpoint under the current midpoint, so pinch also pans. */
  function movePinch(): void {
    const [a, b] = pinchPair();
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, pinchStartScale * (dist / pinchStartDist)));
    const rect = container.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const r = next / pinchStartScale;
    tx = midX - cx - (pinchStartMidX - cx - startTx) * r;
    ty = midY - cy - (pinchStartMidY - cy - startTy) * r;
    scale = next;
    clampPan();
    apply();
  }

  const onPointerDown = (e: PointerEvent) => {
    if (pointers.size === 0) suppressClick = false;
    const onImg = e.target === img;
    // A lone pointer off the image is a tap on the backdrop, which the hosts
    // treat as close; only a second finger makes it part of a gesture.
    if (pointers.size === 0 && !onImg) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (pointers.size === 1) {
      panning = true;
      dragged = false;
      beginPan(e.clientX, e.clientY);
    } else if (pointers.size === 2) {
      suppressClick = true;
      panning = false;
      beginPinch();
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size >= 2) {
      movePinch();
      return;
    }
    if (!panning) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!dragged && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
      dragged = true;
      suppressClick = true;
      img.style.cursor = "grabbing";
    }
    if (dragged) {
      tx = startTx + dx;
      ty = startTy + dy;
      clampPan();
      apply();
    }
  };

  const onPointerEnd = (e: PointerEvent) => {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size === 1) {
      // Pinch down to one finger: carry on as a pan from where it is now,
      // rather than jumping back to the pan's original anchor.
      const [rest] = [...pointers.values()];
      panning = true;
      dragged = true;
      beginPan(rest!.x, rest!.y);
      return;
    }
    if (pointers.size > 0) return;
    const wasTap = panning && !dragged && !suppressClick && e.type === "pointerup";
    panning = false;
    if (wasTap) {
      // A click, not a drag: toggle between fit and a fixed zoomed-in level,
      // animated - zoomAt() already calls apply(true) internally.
      zoomAt(e.clientX, e.clientY, scale <= MIN_SCALE ? CLICK_ZOOM_SCALE : MIN_SCALE, true);
      return;
    }
    if (scale <= MIN_SCALE) {
      tx = 0;
      ty = 0;
      apply(true); // a pinch released at fit glides back to centre
    } else {
      apply(); // just restore the cursor after a drag-pan ends
    }
  };

  const onClickCapture = (e: MouseEvent) => {
    if (!suppressClick) return;
    e.stopPropagation();
    e.preventDefault();
  };

  container.addEventListener("pointerdown", onPointerDown);
  container.addEventListener("pointermove", onPointerMove);
  container.addEventListener("pointerup", onPointerEnd);
  container.addEventListener("pointercancel", onPointerEnd);
  container.addEventListener("click", onClickCapture, true);

  return () => {
    container.removeEventListener("wheel", onWheel);
    container.removeEventListener("pointerdown", onPointerDown);
    container.removeEventListener("pointermove", onPointerMove);
    container.removeEventListener("pointerup", onPointerEnd);
    container.removeEventListener("pointercancel", onPointerEnd);
    container.removeEventListener("click", onClickCapture, true);
  };
}
