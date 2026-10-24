// The quick-action chips live on ONE line that scrolls sideways. Its scrollbar
// stays invisible until the row is actually moving, the edges fade only where
// there is more to scroll to, and a plain mouse wheel scrolls it as well
// (Windows only scrolls a horizontal box by wheel with Shift held).

/** How long after the last scroll event the scrollbar fades back out. */
const IDLE_MS = 700;
const idleTimers = new WeakMap<HTMLElement, number>();

/** Fades whichever edge still has chips beyond it. */
export function syncEdges(track: HTMLElement): void {
  track.classList.toggle("fade-l", track.scrollLeft > 1);
  track.classList.toggle("fade-r", track.scrollLeft + track.clientWidth < track.scrollWidth - 1);
}

export function onTrackScroll(e: Event): void {
  const track = e.currentTarget as HTMLElement;
  track.classList.add("is-scrolling");
  window.clearTimeout(idleTimers.get(track));
  idleTimers.set(track, window.setTimeout(() => track.classList.remove("is-scrolling"), IDLE_MS));
  syncEdges(track);
}

/** A vertical wheel turn moves the row sideways, until the row hits its end
 *  in that direction; from there the page scrolls as usual. */
export function onTrackWheel(e: WheelEvent): void {
  const track = e.currentTarget as HTMLElement;
  if (e.deltaX !== 0 || e.deltaY === 0) return;
  const max = track.scrollWidth - track.clientWidth;
  if (max <= 0) return;
  if ((e.deltaY > 0 && track.scrollLeft >= max - 1) || (e.deltaY < 0 && track.scrollLeft <= 0)) return;
  track.scrollLeft += e.deltaY;
  e.preventDefault();
}
