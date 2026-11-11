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
// question, the X (top-right) returns to the card on the same question. A
// strip of every option's thumbnail along the bottom jumps straight to one,
// and the top bar's text toggle floats the option's description over the
// bottom of the preview.
//
// A question's own picture (Question.preview) opens the same overlay in
// "plain" mode: the canvas with zoom and pan and the close button, none of the
// option paging or Select bar, since the picture belongs to the question and
// picks nothing.
//
// The overlay lives on <body>, not in the card host, because every card
// render() rebuilds the host's innerHTML and would wipe it.

import { escapeHtml } from "../../../shared/escape-html";
import { setupImageZoomPan } from "../../../shared/chat/image-zoom-pan";
import { previewDocument } from "./option-preview-doc";
import { inlineLocalImages } from "./option-preview-images";
import { hasQuestionPreview, previewedOptions } from "./option-previews";
import type { Question, Selection } from "./types";
import "../permission-modal-preview-fullscreen.css";

const PREVIEW_FULLSCREEN_CLASS = "auq-fs";

// Px of sideways travel, at fit zoom, before a drag counts as paging.
const SWIPE_PX = 50;

// The option-text toggle is remembered per device across cards (Joe,
// 2026-10-25): it is a reading preference, and the phone and the desktop can
// want it differently. Shown until first turned off.
const TEXT_PREF_KEY = "cc.auqFullscreen.optionText";

function readTextPref(): boolean {
  try { return localStorage.getItem(TEXT_PREF_KEY) !== "off"; } catch { return true; }
}

function writeTextPref(on: boolean): void {
  try { localStorage.setItem(TEXT_PREF_KEY, on ? "on" : "off"); } catch { /* private mode: in-memory only */ }
}

const MAX_REFITS = 4;

/** A page taller than the view would be cut off at the bottom: the frame's
 *  document clips its own overflow and nothing scrolls it. So the frame is laid
 *  out at the page's full height (same width as the view, so the layout stays
 *  the screen-width one) and shrunk to fit the view's height; zoom then reads
 *  the detail. A page that already fits is left at the view's size. */
function fitFrameToView(frame: HTMLIFrameElement, view: HTMLElement): void {
  const doc = frame.contentDocument?.documentElement;
  const viewH = view.clientHeight;
  if (!doc || viewH <= 0) return;
  // Back to the view's own height first: the page's min-height is 100vh, so a
  // frame already stretched to a past height would report that height again.
  frame.style.height = "";
  frame.style.transform = "";
  let pageH = doc.scrollHeight;
  if (pageH <= viewH + 1) return;
  frame.style.height = `${pageH}px`;
  // Parts sized in vh grow once the frame is stretched, so the height just
  // measured is short for the stretched layout. Re-measure until it settles; a
  // page whose vh parts add up to a full viewport or more never settles, so the
  // loop is bounded and that page keeps its last (still clipped) height.
  for (let i = 0; i < MAX_REFITS; i++) {
    const grown = doc.scrollHeight;
    if (grown <= pageH + 1) break;
    pageH = grown;
    frame.style.height = `${pageH}px`;
  }
  frame.style.transformOrigin = "top center";
  frame.style.transform = `scale(${viewH / pageH})`;
}

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
  /** Opens question `qi`'s own picture, with no option paging. */
  openQuestion: (qi: number) => void;
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
  let stripFor = -1;
  let textOn = readTextPref();
  let plain = false;

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
        <button type="button" class="auq-fs__icon auq-fs__text-toggle" data-fs="text"><i class="ph ph-text-align-left"></i></button>
        <button type="button" class="auq-fs__icon" data-fs="close" title="Back to the card" aria-label="Close fullscreen"><i class="ph ph-x"></i></button>
      </div>
      <div class="auq-fs__view"><div class="auq-fs__desc" hidden></div></div>
      <div class="auq-fs__bar">
        <div class="auq-fs__nav">
          <button type="button" class="auq-fs__icon auq-fs__arrow" data-fs="prev" title="Previous option" aria-label="Previous option"><i class="ph ph-caret-left"></i></button>
          <div class="auq-fs__strip"></div>
          <button type="button" class="auq-fs__icon auq-fs__arrow" data-fs="next" title="Next option" aria-label="Next option"><i class="ph ph-caret-right"></i></button>
        </div>
        <div class="auq-fs__actions">
          <div class="auq-fs__opt"><span class="auq-fs__label"></span><span class="auq-fs__count"></span></div>
          <button type="button" class="btn auq-fs__select" data-fs="select"></button>
          <button type="button" class="btn btn-primary auq-fs__advance" data-fs="advance" hidden><i class="ph ph-caret-right"></i> Next</button>
        </div>
      </div>
    `;
    el.addEventListener("click", (e) => {
      const thumb = (e.target as HTMLElement).closest<HTMLElement>("[data-fs-thumb]");
      if (thumb) { idx = Number(thumb.dataset.fsThumb); sync(); return; }
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-fs]")?.dataset.fs;
      if (act === "text") { textOn = !textOn; writeTextPref(textOn); sync(); }
      else if (act === "back") back();
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
  // pointers down is a pinch, never a page turn. Not swipe-detector.ts's
  // attachSwipe on purpose: that one listens to touch events only (this view
  // also pages by mouse and pen), keeps tracking when a second finger lands
  // mid-gesture, and has no gate to read the live zoom scale, so all three
  // would need adding there.
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
    const html = plain ? questions[qi]?.preview : opt?.preview;
    if (!html) return;
    const key = plain ? `${qi}\u0000#question` : `${qi}\u0000${opt!.label}`;
    if (key === shownKey) return;
    shownKey = key;
    disposeZoom?.();
    const view = root.querySelector<HTMLElement>(".auq-fs__view")!;
    // Only the canvas is swapped: the description overlay is its sibling.
    view.querySelector(".auq-fs__canvas")?.remove();
    const canvas = document.createElement("div");
    canvas.className = "auq-fs__canvas";
    // allow-same-origin and no allow-scripts: the fragment still cannot run
    // anything, but the parent can read its height to fit a tall page.
    canvas.innerHTML = `<iframe class="auq-fs__frame" sandbox="allow-same-origin" tabindex="-1" aria-hidden="true"></iframe>`;
    const frame = canvas.querySelector<HTMLIFrameElement>(".auq-fs__frame")!;
    const fit = () => fitFrameToView(frame, view);
    frame.addEventListener("load", () => {
      fit();
      // An image landing after load can grow the page.
      frame.contentDocument?.addEventListener("load", fit, true);
    });
    frame.srcdoc = previewDocument(inlineLocalImages(html, sessionId));
    view.prepend(canvas);
    const resizeWatch = new ResizeObserver(fit);
    resizeWatch.observe(view);
    scale = 1;
    const disposePan = setupImageZoomPan(canvas, view, (s) => { scale = s; });
    disposeZoom = () => { disposePan(); resizeWatch.disconnect(); };
  }

  // Built once per question; sync() only moves the highlight and the checks.
  // Each thumbnail lays the preview out at 5x its box and scales it to 0.2,
  // like the card's filmstrip, so it reads as a shrunken page, not a reflow.
  function paintStrip(): void {
    if (!root || stripFor === qi) return;
    stripFor = qi;
    root.querySelector<HTMLElement>(".auq-fs__strip")!.innerHTML = options().map((o, i) =>
      `<button type="button" class="auq-fs__thumb" data-fs-thumb="${i}" title="${escapeHtml(o.label)}" aria-label="${escapeHtml(o.label)}"><iframe class="auq-fs__thumb-frame" sandbox="" tabindex="-1" aria-hidden="true" srcdoc="${escapeHtml(previewDocument(inlineLocalImages(o.preview!, sessionId)))}"></iframe><i class="ph-fill ph-check-circle auq-fs__thumb-pick" hidden></i></button>`,
    ).join("");
  }

  function syncPlain(): void {
    const q = questions[qi];
    if (!root || !q || !hasQuestionPreview(q)) { close(); return; }
    paintFrame();
    const setText = (sel: string, value: string) => {
      const el = root!.querySelector<HTMLElement>(sel);
      if (el && el.textContent !== value) el.textContent = value;
    };
    setText(".auq-fs__qcount", questions.length > 1 ? `${qi + 1}/${questions.length}` : "");
    setText(".auq-fs__qtext", q.header || q.question);
    root.querySelector<HTMLElement>(".auq-fs__qtext")!.title = q.question;
  }

  function sync(): void {
    if (!root) return;
    if (plain) { syncPlain(); return; }
    const q = questions[qi];
    const opts = options();
    if (!q || !opts.length) { close(); return; }
    idx = Math.min(Math.max(idx, 0), opts.length - 1);
    paintFrame();
    paintStrip();
    const opt = opts[idx]!;
    const sel = selections.get(qi);
    const picked = isPicked(sel, opt.label);
    root.querySelectorAll<HTMLElement>(".auq-fs__thumb").forEach((t) => {
      const i = Number(t.dataset.fsThumb);
      t.classList.toggle("is-current", i === idx);
      const o = opts[i];
      t.querySelector<HTMLElement>(".auq-fs__thumb-pick")!.hidden = !o || !isPicked(sel, o.label);
    });
    root.querySelector(".auq-fs__thumb.is-current")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    const toggleBtn = root.querySelector<HTMLButtonElement>('[data-fs="text"]')!;
    toggleBtn.classList.toggle("is-on", textOn);
    toggleBtn.setAttribute("aria-pressed", String(textOn));
    toggleBtn.title = textOn ? "Hide option text" : "Show option text";
    toggleBtn.setAttribute("aria-label", toggleBtn.title);
    const desc = root.querySelector<HTMLElement>(".auq-fs__desc")!;
    const descText = opt.description?.trim() ?? "";
    desc.hidden = !textOn || !descText;
    if (desc.textContent !== descText) desc.textContent = descText;
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
    const keys: Record<string, () => void> = plain
      ? { Escape: close }
      : { Escape: close, ArrowLeft: () => step(-1), ArrowRight: () => step(1), Enter: select };
    const fn = keys[e.key];
    if (!fn) return;
    e.stopPropagation();
    // Enter on one of the overlay's own buttons is that button's click.
    if (e.key === "Enter" && document.activeElement instanceof HTMLButtonElement && root.contains(document.activeElement)) return;
    e.preventDefault();
    fn();
  };

  function mount(): HTMLElement {
    if (!root) {
      returnFocus = document.activeElement;
      root = build();
      document.body.appendChild(root);
      window.addEventListener("keydown", onKey, true);
    }
    return root;
  }

  function open(target: number, label?: string): void {
    if (!hasPreviews(questions[target])) return;
    const el = mount();
    plain = false;
    el.classList.remove(`${PREVIEW_FULLSCREEN_CLASS}--plain`);
    goToTab(target);
    show(target, label);
    el.querySelector<HTMLButtonElement>('[data-fs="select"]')?.focus();
  }

  function openQuestion(target: number): void {
    if (!hasQuestionPreview(questions[target])) return;
    const el = mount();
    plain = true;
    el.classList.add(`${PREVIEW_FULLSCREEN_CLASS}--plain`);
    goToTab(target);
    qi = target;
    shownKey = "";
    sync();
    el.querySelector<HTMLButtonElement>('[data-fs="close"]')?.focus();
  }

  function close(): void {
    if (!root) return;
    disposeZoom?.();
    disposeZoom = null;
    window.removeEventListener("keydown", onKey, true);
    root.remove();
    root = null;
    plain = false;
    shownKey = "";
    stripFor = -1;
    if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus();
    returnFocus = null;
  }

  return { open, openQuestion, close, isOpen: () => root !== null, sync };
}
