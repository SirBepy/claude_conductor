import { escapeHtml } from "../../../../shared/escape-html";

export interface ValueSlider {
  /** Moves the thumb to `idx` with the transition, without calling `onCommit`. */
  set(idx: number): void;
}

export interface ValueSliderOpts {
  label: string;
  stops: string[];
  /** Tooltip per stop, by index. */
  hints?: Record<number, string>;
  index: number;
  onCommit: (idx: number) => void;
}

/** A stepped slider with a label under each stop. Divs rather than a native
 *  range input: a native thumb snaps on a programmatic change (its position is
 *  not a transitionable property), and a revert after a failed save should glide
 *  back. Stops sit in equal columns and the track is inset by half a column, so
 *  every thumb position lands on its label's centre. */
export function mountValueSlider(host: HTMLElement, o: ValueSliderOpts): ValueSlider {
  const max = o.stops.length - 1;
  let current = Math.min(Math.max(o.index, 0), max);
  host.innerHTML = `
    <div class="vs" style="--n:${o.stops.length}">
      <div class="vs-wrap" role="slider" tabindex="0" aria-label="${escapeHtml(o.label)}" aria-valuemin="0" aria-valuemax="${max}">
        <div class="vs-track"><div class="vs-fill"></div><div class="vs-thumb"></div></div>
      </div>
      <div class="vs-stops">
        ${o.stops.map((s, i) => `<button type="button" class="vs-stop" data-idx="${i}" tabindex="-1"${o.hints?.[i] ? ` title="${escapeHtml(o.hints[i])}"` : ""}>${escapeHtml(s)}</button>`).join("")}
      </div>
    </div>`;
  const wrap = host.querySelector<HTMLElement>(".vs-wrap")!;
  const track = host.querySelector<HTMLElement>(".vs-track")!;
  const fill = host.querySelector<HTMLElement>(".vs-fill")!;
  const thumb = host.querySelector<HTMLElement>(".vs-thumb")!;
  const stops = [...host.querySelectorAll<HTMLElement>(".vs-stop")];

  const show = (idx: number): void => {
    const pct = max > 0 ? (idx / max) * 100 : 0;
    fill.style.width = `${pct}%`;
    thumb.style.left = `${pct}%`;
    stops.forEach((el, i) => el.classList.toggle("active", i === idx));
    wrap.setAttribute("aria-valuenow", String(idx));
    wrap.setAttribute("aria-valuetext", o.stops[idx] ?? "");
  };
  const commit = (idx: number): void => {
    if (idx === current) { show(current); return; }
    current = idx;
    show(idx);
    o.onCommit(idx);
  };
  const idxAt = (clientX: number): number => {
    const r = track.getBoundingClientRect();
    return Math.round(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * max);
  };

  // The thumb follows the pointer 1:1 while dragging (transitions off, like a
  // native slider) and the value only commits on release.
  let dragging = false;
  wrap.addEventListener("pointerdown", (e) => {
    dragging = true;
    wrap.classList.add("is-drag");
    wrap.setPointerCapture(e.pointerId);
    show(idxAt(e.clientX));
  });
  wrap.addEventListener("pointermove", (e) => { if (dragging) show(idxAt(e.clientX)); });
  const release = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    wrap.classList.remove("is-drag");
    commit(idxAt(e.clientX));
  };
  wrap.addEventListener("pointerup", release);
  wrap.addEventListener("pointercancel", () => { dragging = false; wrap.classList.remove("is-drag"); show(current); });
  wrap.addEventListener("keydown", (e) => {
    let next = current;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(max, current + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(0, current - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = max;
    else return;
    e.preventDefault();
    commit(next);
  });
  stops.forEach((el, i) => el.addEventListener("click", () => commit(i)));

  // First paint lands on the value without gliding in from zero.
  wrap.classList.add("is-drag");
  show(current);
  void wrap.offsetWidth;
  wrap.classList.remove("is-drag");

  return { set(idx) { current = idx; show(idx); } };
}
