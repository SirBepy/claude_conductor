// The quick-action chips live on ONE line: a clipped track that slides by whole
// pages, a page being the chips that fully fit. The paging maths is pure
// (tested with fake chip boxes); the DOM half measures the real chips because
// their widths depend on the commands and the font.

export interface Box { left: number, width: number }

const right = (b: Box): number => b.left + b.width;

/** True when every chip fits in `track` px starting from the first. */
export function fitsAll(chips: Box[], track: number): boolean {
  const first = chips[0];
  const last = chips[chips.length - 1];
  return !first || !last || right(last) - first.left <= track;
}

/** Is the last chip fully inside the window that starts at chip `start`? */
export function atEnd(chips: Box[], start: number, track: number): boolean {
  const first = chips[start];
  const last = chips[chips.length - 1];
  return !first || !last || right(last) - first.left <= track;
}

/** The first chip that does not fully fit from `start`; it starts the next page. */
export function nextStart(chips: Box[], start: number, track: number): number {
  const base = chips[start]?.left ?? 0;
  for (let j = start + 1; j < chips.length; j++) {
    if (right(chips[j]!) - base > track) return j;
  }
  return start;
}

/** The earliest chip such that the chips from it up to `start` still fit: the page that ends right before `start`. */
export function prevStart(chips: Box[], start: number, track: number): number {
  if (start <= 0) return 0;
  const end = right(chips[start - 1]!);
  let i = start - 1;
  while (i > 0 && end - chips[i - 1]!.left <= track) i--;
  return i;
}

function parts(qa: HTMLElement): { track: HTMLElement, strip: HTMLElement, chips: HTMLElement[], prev: HTMLButtonElement, next: HTMLButtonElement } | null {
  const track = qa.querySelector<HTMLElement>(".pd-qa-track");
  const strip = qa.querySelector<HTMLElement>(".pd-qa-strip");
  const prev = qa.querySelector<HTMLButtonElement>('[data-pd-qa-dir="-1"]');
  const next = qa.querySelector<HTMLButtonElement>('[data-pd-qa-dir="1"]');
  if (!track || !strip || !prev || !next) return null;
  return { track, strip, chips: [...strip.querySelectorAll<HTMLElement>(".pd-chip")], prev, next };
}

const boxes = (chips: HTMLElement[]): Box[] => chips.map((c) => ({ left: c.offsetLeft, width: c.offsetWidth }));

/** Slides the strip to chip `start` and sets the arrows; returns the start actually used. */
export function syncTrack(qa: HTMLElement, wanted: number): number {
  const p = parts(qa);
  if (!p) return 0;
  const bs = boxes(p.chips);
  const full = qa.clientWidth;
  // Judged against the whole row, not the track: the arrows only take room when needed.
  const fit = fitsAll(bs, full);
  qa.classList.toggle("is-fit", fit);
  const trackW = fit ? full : p.track.clientWidth;
  const start = fit || wanted >= bs.length ? 0 : Math.max(0, wanted);
  p.strip.style.transform = `translateX(${-(bs[start]?.left ?? 0)}px)`;
  p.prev.disabled = start === 0;
  p.next.disabled = atEnd(bs, start, trackW);
  return start;
}

/** One page forward (+1) or back (-1) from `start`; returns the new start. */
export function moveTrack(qa: HTMLElement, start: number, dir: 1 | -1): number {
  const p = parts(qa);
  if (!p) return start;
  const bs = boxes(p.chips);
  const trackW = p.track.clientWidth;
  const to = dir === 1 ? nextStart(bs, start, trackW) : prevStart(bs, start, trackW);
  return syncTrack(qa, to);
}
