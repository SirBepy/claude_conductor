// Mobile bottom-sheet peek gesture: drag the handle down to glimpse the chat
// behind the card, flick or tap back up to restore. Delegated on the stable
// host element so it survives renderCardShell()'s innerHTML re-renders. Inert
// on desktop: the handle is display:none there, so pointerdown never fires.

const PEEK_RATIO = 0.72; // preferred fraction of the card's own height to reveal
const MIN_KEEP_VISIBLE = 56; // px of the card (handle + a sliver) that must stay reachable
const FLICK_VELOCITY = 0.5; // px/ms - a fast flick wins over raw drag distance
const TAP_SLOP = 6; // px - drags shorter than this are treated as a tap

function currentOffset(card: HTMLElement): number {
  const m = /translateY\(([-\d.]+)px\)/.exec(card.style.transform);
  return m?.[1] ? parseFloat(m[1]) : 0;
}

function settle(card: HTMLElement, offset: number, peeked: boolean): void {
  card.style.transition = "";
  card.style.transform = peeked ? `translateY(${offset}px)` : "";
  card.classList.toggle("prompt-card--peeked", peeked);
}

/** Wires the drag gesture on `host`; returns a detach function. */
export function attachDragHandle(host: HTMLElement): () => void {
  let card: HTMLElement | null = null;
  let startY = 0;
  let baseOffset = 0;
  let peekMax = 0;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0;
  let moved = 0;

  const onMove = (e: PointerEvent) => {
    if (!card) return;
    const dt = e.timeStamp - lastT;
    if (dt > 0) velocity = (e.clientY - lastY) / dt;
    lastY = e.clientY;
    lastT = e.timeStamp;
    const delta = e.clientY - startY;
    moved = Math.max(moved, Math.abs(delta));
    const offset = Math.min(Math.max(baseOffset + delta, 0), peekMax);
    card.style.transform = `translateY(${offset}px)`;
  };

  const stopListening = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  };

  function onUp(): void {
    if (!card) return;
    const c = card;
    card = null;
    stopListening();

    // A tap (no real drag) only ever restores - never peeks. That keeps a
    // stray tap on an already-open card a no-op, and guarantees a peeked
    // card is always one tap away from reachable again.
    if (moved < TAP_SLOP) { settle(c, 0, false); return; }

    const fastDown = velocity > FLICK_VELOCITY;
    const fastUp = velocity < -FLICK_VELOCITY;
    const peekNow = fastDown || (!fastUp && currentOffset(c) > peekMax / 2);
    settle(c, peekMax, peekNow);
  }

  const onDown = (e: PointerEvent) => {
    const handle = (e.target as HTMLElement).closest<HTMLElement>(".prompt-card__handle");
    if (!handle) return;
    const c = handle.closest<HTMLElement>(".prompt-card");
    if (!c) return;
    card = c;
    moved = 0;
    startY = e.clientY;
    lastY = e.clientY;
    lastT = e.timeStamp;
    velocity = 0;
    baseOffset = currentOffset(c);

    // Clamp the peek distance so the card's bottom edge can never pass the
    // viewport's bottom edge (.session-pane clips overflow - see host.ts's
    // mobile height-cap comment) and its top always keeps MIN_KEEP_VISIBLE
    // reachable, on top of the PEEK_RATIO the gesture prefers.
    const rect = c.getBoundingClientRect();
    const roomBelow = window.innerHeight - rect.bottom;
    peekMax = Math.max(0, Math.min(
      rect.height * PEEK_RATIO,
      rect.height - MIN_KEEP_VISIBLE,
      roomBelow,
    ));

    c.style.transition = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  host.addEventListener("pointerdown", onDown);
  return () => {
    host.removeEventListener("pointerdown", onDown);
    stopListening();
  };
}
