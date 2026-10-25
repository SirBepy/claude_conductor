// Fullscreen mode for a question's visual option previews (Joe, 2026-10-25).
// The card's tiles and stage crop a preview to 150/210px and let nothing
// through to it, so a mockup could never be read whole. Tapping a preview
// opens it here at the full screen size, zoomable and pannable like an image,
// with the question's options paged left/right along the bottom.
//
// Answering stays in this mode: Select (single-select) picks the shown option
// and moves to the next question, which opens here again if it has previews
// and drops back to the normal card if it does not. A multi-select question
// toggles with Select and moves on with Next. Back (top-left) is the previous
// question, the X (top-right) returns to the card on the same question.
//
// The overlay lives on <body>, not in the card host, because every card
// render() rebuilds the host's innerHTML and would wipe it.

import { escapeHtml } from "../../../shared/escape-html";
import { setupImageZoomPan } from "../../../shared/chat/image-zoom-pan";
import { previewDocument } from "./option-preview-doc";
import { inlineLocalImages } from "./option-preview-images";
import { previewedOptions } from "./option-previews";
import type { Question, Selection } from "./types";
import "../permission-modal-preview-fullscreen.css";

export const PREVIEW_FULLSCREEN_CLASS = "auq-fs";

// Px of sideways travel, at fit zoom, before a drag counts as paging.
const SWIPE_PX = 50;

export interface PreviewFullscreenDeps {
  questions: Question[];
  selections: Map<number, Selection>;
  hasSummary: boolean;
  sessionId?: string;
  answeredAt: (qi: number) => boolean;
  /** Single-select: set the pick without the card's own auto-advance. */
  pick: (qi: number, label: string) => void;
  /** Multi-select: flip one option. */
  toggle: (qi: number, label: string) => void;
  /** The card's own navigation, so the card under the overlay stays on the
   *  question shown here. */
  goToTab: (target: number) => void;
}

export interface PreviewFullscreen {
  open: (qi: number, label?: string) => void;
  close: () => void;
  isOpen: () => boolean;
  /** Repaints the bar from the live selections (a pick from another device). */
  sync: () => void;
}

function isPicked(sel: Selection | undefined, label: string): boolean {
  return sel instanceof Set ? sel.has(label) : sel === label;
}

export function hasPreviews(q: Question | undefined): boolean {
  return Boolean(q) && previewedOptions(q!).length > 0;
}

export function createPreviewFullscreen(deps: PreviewFullscreenDeps): PreviewFullscreen {
  const { questions, selections, hasSummary, sessionId, answeredAt, pick, toggle, goToTab } = deps;
  let root: HTMLElement | null = null;
  let qi = 0;
  let idx = 0;
  let scale = 1;
  let disposeZoom: (() => void) | null = null;
  let shownKey = "";
  let returnFocus: Element | null = null;

  const options = () => previewedOptions(questions[qi]!);

  function build(): HTMLElement {
    const el = document.createElement("div");
    el.className = PREVIEW_FULLSCREEN_CLASS;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.innerHTML = `
      <div class="auq-fs__top">
        <button type="button" class="auq-fs__icon" data-fs="back" title="Previous question" aria-label="Previous question"><i class="ph ph-arrow-left"></i></button>
        <div class="auq-fs__title"><span class="auq-fs__qcount"></span><span class="auq-fs__qtext"></span></div>
        <button type="button" class="auq-fs__icon" data-fs="close" title="Back to the card" aria-label="Close fullscreen"><i class="ph ph-x"></i></button>
      </div>
      <div class="auq-fs__view"></div>
      <div class="auq-fs__bar">
        <div class="auq-fs__nav">
          <button type="button" class="auq-fs__icon" data-fs="prev" title="Previous option" aria-label="Previous option"><i class="ph ph-caret-left"></i></button>
          <div class="auq-fs__opt"><span class="auq-fs__label"></span><span class="auq-fs__count"></span></div>
          <button type="button" class="auq-fs__icon" data-fs="next" title="Next option" aria-label="Next option"><i class="ph ph-caret-right"></i></button>
        </div>
        <div class="auq-fs__actions">
          <button type="button" class="btn auq-fs__select" data-fs="select"></button>
          <button type="button" class="btn btn-primary auq-fs__advance" data-fs="advance" hidden><i class="ph ph-caret-right"></i> Next</button>
        </div>
      </div>
    `;
    el.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-fs]")?.dataset.fs;
      if (act === "back") back();
      else if (act === "close") close();
      else if (act === "prev") step(-1);
      else if (act === "next") step(1);
      else if (act === "select") select();
      else if (act === "advance") advance();
    });
    wireSwipe(el.querySelector<HTMLElement>(".auq-fs__view")!);
    return el;
  }

  // Sideways drag pages options, but only at fit zoom: zoomed in, the same
  // drag is a pan (image-zoom-pan.ts owns it). A gesture that ever had two
  // pointers down is a pinch, never a page turn.
  function wireSwipe(view: HTMLElement): void {
    let start: { x: number; y: number; id: number } | null = null;
    let multi = false;
    view.addEventListener("pointerdown", (e) => {
      if (start) { multi = true; return; }
      multi = false;
      start = scale <= 1 ? { x: e.clientX, y: e.clientY, id: e.pointerId } : null;
    });
    const end = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      start = null;
      if (multi || e.type !== "pointerup" || scale > 1) return;
      if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
    };
    view.addEventListener("pointerup", end);
    view.addEventListener("pointercancel", end);
  }

  // A new canvas per option, so each one opens at fit zoom.
  function paintFrame(): void {
    if (!root) return;
    const opt = options()[idx];
    if (!opt) return;
    const key = `${qi}\u0000${opt.label}`;
    if (key === shownKey) return;
    shownKey = key;
    disposeZoom?.();
    const view = root.querySelector<HTMLElement>(".auq-fs__view")!;
    view.innerHTML = `<div class="auq-fs__canvas"><iframe class="auq-fs__frame" sandbox="" tabindex="-1" aria-hidden="true"></iframe></div>`;
    view.querySelector<HTMLIFrameElement>(".auq-fs__frame")!.srcdoc = previewDocument(inlineLocalImages(opt.preview!, sessionId));
    scale = 1;
    disposeZoom = setupImageZoomPan(view.querySelector<HTMLElement>(".auq-fs__canvas")!, view, (s) => { scale = s; });
  }

  function sync(): void {
    if (!root) return;
    const q = questions[qi];
    const opts = options();
    if (!q || !opts.length) { close(); return; }
    idx = Math.min(Math.max(idx, 0), opts.length - 1);
    paintFrame();
    const opt = opts[idx]!;
    const sel = selections.get(qi);
    const picked = isPicked(sel, opt.label);
    const text = (sel: string, value: string) => {
      const el = root!.querySelector<HTMLElement>(sel);
      if (el && el.textContent !== value) el.textContent = value;
    };
    text(".auq-fs__qcount", questions.length > 1 ? `${qi + 1}/${questions.length}` : "");
    text(".auq-fs__qtext", q.header || q.question);
    root.querySelector<HTMLElement>(".auq-fs__qtext")!.title = q.question;
    text(".auq-fs__count", `${idx + 1}/${opts.length}`);
    const label = root.querySelector<HTMLElement>(".auq-fs__label")!;
    label.innerHTML = `${picked ? `<i class="ph-fill ph-check-circle"></i>` : ""}${escapeHtml(opt.label)}`;
    label.classList.toggle("is-picked", picked);
    root.querySelector<HTMLButtonElement>('[data-fs="prev"]')!.disabled = idx === 0;
    root.querySelector<HTMLButtonElement>('[data-fs="next"]')!.disabled = idx === opts.length - 1;

    const selectBtn = root.querySelector<HTMLButtonElement>('[data-fs="select"]')!;
    const advanceBtn = root.querySelector<HTMLButtonElement>('[data-fs="advance"]')!;
    if (q.multiSelect) {
      selectBtn.className = `btn ${picked ? "btn-primary" : "btn-secondary"} auq-fs__select`;
      selectBtn.innerHTML = picked ? `<i class="ph ph-check-square"></i> Selected` : `<i class="ph ph-square"></i> Select`;
      selectBtn.setAttribute("aria-pressed", String(picked));
      advanceBtn.hidden = false;
      // Same gate as the card's Next: a multi-select needs a real answer.
      advanceBtn.disabled = !answeredAt(qi);
    } else {
      selectBtn.className = "btn btn-primary auq-fs__select";
      selectBtn.innerHTML = `<i class="ph ph-check"></i> Select`;
      selectBtn.removeAttribute("aria-pressed");
      advanceBtn.hidden = true;
    }
  }

  function step(delta: number): void {
    const next = Math.min(Math.max(idx + delta, 0), options().length - 1);
    if (next === idx) return;
    idx = next;
    sync();
  }

  function show(target: number, label?: string): void {
    qi = target;
    const opts = options();
    const sel = selections.get(qi);
    const want = label ?? opts.find((o) => isPicked(sel, o.label))?.label;
    idx = Math.max(0, opts.findIndex((o) => o.label === want));
    shownKey = "";
    sync();
  }

  /** Leaves question `qi` for `target`: here if it has previews, else the card. */
  function moveTo(target: number): void {
    goToTab(target);
    if (target < questions.length && hasPreviews(questions[target])) show(target);
    else close();
  }

  function select(): void {
    const label = options()[idx]?.label;
    if (!label) return;
    if (questions[qi]!.multiSelect) {
      toggle(qi, label);
      sync();
      return;
    }
    pick(qi, label);
    advance();
  }

  // Past the last question: the review panel when there is one, else the card
  // itself, where Submit is - picking never sends the answer on its own.
  function advance(): void {
    if (questions[qi]?.multiSelect && !answeredAt(qi)) return;
    const next = qi + 1;
    if (next < questions.length || hasSummary) moveTo(next);
    else close();
  }

  function back(): void {
    if (qi === 0) { close(); return; }
    moveTo(qi - 1);
  }

  // Capture on window so these run before the card's document-level keys
  // (arrow paging, Escape blur) and the composer's.
  const onKey = (e: KeyboardEvent) => {
    if (!root || e.altKey || e.ctrlKey || e.metaKey) return;
    const keys: Record<string, () => void> = {
      Escape: close,
      ArrowLeft: () => step(-1),
      ArrowRight: () => step(1),
      Enter: select,
    };
    const fn = keys[e.key];
    if (!fn) return;
    e.stopPropagation();
    // Enter on one of the overlay's own buttons is that button's click.
    if (e.key === "Enter" && document.activeElement instanceof HTMLButtonElement && root.contains(document.activeElement)) return;
    e.preventDefault();
    fn();
  };

  function open(target: number, label?: string): void {
    if (!hasPreviews(questions[target])) return;
    if (!root) {
      returnFocus = document.activeElement;
      root = build();
      document.body.appendChild(root);
      window.addEventListener("keydown", onKey, true);
    }
    goToTab(target);
    show(target, label);
    root.querySelector<HTMLButtonElement>('[data-fs="select"]')?.focus();
  }

  function close(): void {
    if (!root) return;
    disposeZoom?.();
    disposeZoom = null;
    window.removeEventListener("keydown", onKey, true);
    root.remove();
    root = null;
    shownKey = "";
    if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus();
    returnFocus = null;
  }

  return { open, close, isOpen: () => root !== null, sync };
}
