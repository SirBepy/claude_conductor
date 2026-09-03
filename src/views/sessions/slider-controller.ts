// Custom animated-slider sub-component for the new-chat modal, split out of
// model-effort-modal.ts (ai_todo 753) once that file's slider block grew
// large enough to warrant its own module, mirroring the earlier
// character-pane.ts/account-field.ts extractions from the same file.
// model-effort-modal.ts is the only caller; it owns the returned
// SliderController and wires it into renderBody()/attachHandlers() the same
// way it does charPane.

import { escapeHtml } from "../../shared/escape-html";

export type SliderKind = "model" | "effort";

type FlipState = Map<SliderKind, { fill: string; thumbLeft: string }>;

export interface SliderController {
  /** Renders one slider field's HTML (label + track/fill/thumb + stop
   * labels). Native <input type=range> can't animate its thumb on a
   * programmatic value change (WebKit/Blink snap instantly - thumb position
   * isn't a transitionable CSS property), so track+fill+thumb are plain divs. */
  html(kind: SliderKind, label: string, idx: number, stops: string[], labelSuffixHtml?: string): string;
  /** FLIP "first" step - captures each slider's on-screen position right
   * before renderBody() tears the DOM down and rebuilds it. */
  captureFlipState(): FlipState;
  /** FLIP "last/invert/play" - snaps each still-present slider back to its
   * pre-render position, forces reflow, then lets the CSS transition carry
   * it to the position renderBody() already set. A slider with no prior
   * entry (e.g. Effort on first "More options" open) just appears. */
  playFlip(from: FlipState): void;
  /** Snaps both sliders' fill/thumb to their current index, transition
   * disabled - the correct-position baseline every render needs before
   * playFlip() can animate away from it. */
  positionAll(modelIdx: number, effortIdx: number): void;
  /** Wires pointer/keyboard drag + stop-label click handlers. Rerun on every
   * renderBody() since it rebuilds the DOM it wires into. */
  wire(): void;
}

/** Owns the animated model/effort sliders for a new-chat modal, rendering
 * into and wiring `.me-slider-wrap`/`.slider-stop-label` nodes inside `card`.
 * `modelIdx`/`effortIdx` read the modal's current selection; `onCommit` is
 * called with the new index once a drag/click/keypress settles on one - the
 * modal owns applying it to `model`/`effort` and re-rendering. */
export function createSliderController(
  card: HTMLElement,
  opts: {
    modelIdx: () => number;
    effortIdx: () => number;
    onCommit: (kind: SliderKind, idx: number) => void;
  },
): SliderController {
  function positionSliderInstant(wrap: HTMLElement, idx: number): void {
    const max = Number(wrap.dataset.max);
    const pct = max > 0 ? (idx / max) * 100 : 0;
    const fill = wrap.querySelector<HTMLElement>(".me-slider-fill");
    const thumb = wrap.querySelector<HTMLElement>(".me-slider-thumb");
    if (!fill || !thumb) return;
    fill.style.transition = "none";
    thumb.style.transition = "none";
    fill.style.transform = `scaleX(${pct / 100})`;
    thumb.style.left = `${pct}%`;
    fill.getBoundingClientRect(); // force reflow before re-enabling transition
    fill.style.transition = "";
    thumb.style.transition = "";
  }

  function setActiveLabel(kind: SliderKind, idx: number): void {
    card.querySelectorAll<HTMLElement>(`.slider-stop-label[data-kind="${kind}"]`).forEach((el) => {
      el.classList.toggle("active", Number(el.dataset.idx) === idx);
    });
  }

  return {
    html(kind, label, idx, stops, labelSuffixHtml = ""): string {
      const max = stops.length - 1;
      const stopsHtml = stops.map((s, i) => `
        <button type="button" class="slider-stop-label${i === idx ? " active" : ""}" data-kind="${kind}" data-idx="${i}">${escapeHtml(s)}</button>
      `).join("");
      return `
        <div class="me-field">
          <label class="me-label">${escapeHtml(label)}${labelSuffixHtml}</label>
          <div class="me-slider-wrap" data-kind="${kind}" data-min="0" data-max="${max}" role="slider" tabindex="0"
            aria-label="${escapeHtml(label)}" aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${idx}" aria-valuetext="${escapeHtml(stops[idx] ?? "")}">
            <div class="me-slider-track"><div class="me-slider-fill"></div><div class="me-slider-thumb"></div></div>
          </div>
          <div class="me-stop-labels">${stopsHtml}</div>
        </div>
      `;
    },

    captureFlipState(): FlipState {
      const out: FlipState = new Map();
      card.querySelectorAll<HTMLElement>(".me-slider-wrap").forEach((wrap) => {
        const kind = wrap.dataset.kind as SliderKind;
        const fill = wrap.querySelector<HTMLElement>(".me-slider-fill");
        const thumb = wrap.querySelector<HTMLElement>(".me-slider-thumb");
        if (fill && thumb) out.set(kind, { fill: fill.style.transform, thumbLeft: thumb.style.left });
      });
      return out;
    },

    playFlip(from: FlipState): void {
      card.querySelectorAll<HTMLElement>(".me-slider-wrap").forEach((wrap) => {
        const kind = wrap.dataset.kind as SliderKind;
        const prev = from.get(kind);
        if (!prev) return;
        const fill = wrap.querySelector<HTMLElement>(".me-slider-fill");
        const thumb = wrap.querySelector<HTMLElement>(".me-slider-thumb");
        if (!fill || !thumb) return;
        const finalFill = fill.style.transform;
        const finalLeft = thumb.style.left;
        if (prev.fill === finalFill) return; // value didn't change - nothing to animate
        fill.style.transition = "none";
        thumb.style.transition = "none";
        fill.style.transform = prev.fill;
        thumb.style.left = prev.thumbLeft;
        fill.getBoundingClientRect(); // force reflow
        fill.style.transition = "";
        thumb.style.transition = "";
        fill.style.transform = finalFill;
        thumb.style.left = finalLeft;
      });
    },

    positionAll(modelIdx: number, effortIdx: number): void {
      card.querySelectorAll<HTMLElement>(".me-slider-wrap").forEach((wrap) => {
        const kind = wrap.dataset.kind as SliderKind;
        positionSliderInstant(wrap, kind === "model" ? modelIdx : effortIdx);
      });
    },

    wire(): void {
      card.querySelectorAll<HTMLElement>(".me-slider-wrap").forEach((wrap) => {
        const kind = wrap.dataset.kind as SliderKind;
        const min = Number(wrap.dataset.min);
        const max = Number(wrap.dataset.max);
        const track = wrap.querySelector<HTMLElement>(".me-slider-track")!;

        function idxFromClientX(clientX: number): number {
          const rect = track.getBoundingClientRect();
          const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
          return Math.round(min + ratio * (max - min));
        }

        // Live 1:1 tracking while dragging (no transition - matches a native
        // slider's feel); the value only commits (and animates, via the FLIP
        // pass in renderBody) on release.
        let dragging = false;
        wrap.addEventListener("pointerdown", (e) => {
          dragging = true;
          wrap.setPointerCapture(e.pointerId);
          const idx = idxFromClientX(e.clientX);
          positionSliderInstant(wrap, idx);
          setActiveLabel(kind, idx);
        });
        wrap.addEventListener("pointermove", (e) => {
          if (!dragging) return;
          const idx = idxFromClientX(e.clientX);
          positionSliderInstant(wrap, idx);
          setActiveLabel(kind, idx);
        });
        wrap.addEventListener("pointerup", (e) => {
          if (!dragging) return;
          dragging = false;
          opts.onCommit(kind, idxFromClientX(e.clientX));
        });

        wrap.addEventListener("keydown", (e) => {
          const cur = kind === "model" ? opts.modelIdx() : opts.effortIdx();
          let next = cur;
          if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(max, cur + 1);
          else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(min, cur - 1);
          else if (e.key === "Home") next = min;
          else if (e.key === "End") next = max;
          else return;
          e.preventDefault();
          opts.onCommit(kind, next);
        });
      });

      card.querySelectorAll<HTMLButtonElement>(".slider-stop-label").forEach((btn) => {
        btn.addEventListener("click", () => {
          const kind = btn.dataset.kind as SliderKind;
          const idx = Number(btn.dataset.idx);
          opts.onCommit(kind, idx);
        });
      });
    },
  };
}
