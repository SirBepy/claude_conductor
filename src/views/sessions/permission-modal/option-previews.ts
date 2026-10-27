// Visual option previews on the question card. Layout, settled with Joe on
// 2026-10-17 over a mockup of this card:
// - desktop, 1-3 previewed options: side-by-side tiles, picture on top;
// - desktop 4+, or any phone: one big stage above the normal option list.
// On desktop the stage follows hover, then the pick. On phone there is no
// hover, so "viewing" is its own state: swipe the picture up/down (sideways
// stays question paging, question-swipe.ts) or tap a filmstrip thumbnail,
// and "Choose this" picks what is shown. Tapping a row still picks directly.
// Both crop the picture, so both can open it fullscreen (preview-fullscreen.ts):
// a tile only from its corner button (the picture is part of the option, a
// click there picks it), the stage from a tap anywhere on the picture too (it
// is not tied to one option).

import { escapeHtml } from "../../../shared/escape-html";
import { isMobileViewport } from "../../../shared/mobile-viewport";
import { previewDocument } from "./option-preview-doc";
import { inlineLocalImages, prefetchLocalImages } from "./option-preview-images";
import { attachSwipe } from "./swipe-detector";
import type { Question, QuestionOption, Selection } from "./types";

export const TILE_MAX = 3;

export type PreviewLayout = "tiles" | "stage";

export function previewedOptions(q: Question): QuestionOption[] {
  return (q.options ?? []).filter((o) => typeof o.preview === "string" && o.preview.trim() !== "");
}

export function previewLayout(q: Question): PreviewLayout | null {
  const n = previewedOptions(q).length;
  if (n === 0) return null;
  return n <= TILE_MAX && !isMobileViewport() ? "tiles" : "stage";
}

// tabindex -1: the card's keyboard nav walks the option inputs, never frames.
function frameHtml(fragment: string, cls: string, sessionId?: string): string {
  return `<iframe class="${cls}" sandbox="" tabindex="-1" aria-hidden="true" srcdoc="${escapeHtml(previewDocument(inlineLocalImages(fragment, sessionId)))}"></iframe>`;
}

const EXPAND_ICON = (cls: string) => `<i class="ph ph-arrows-out ${cls}" aria-hidden="true"></i>`;

/** The picture on top of a tile row. Rows without a preview (the synthetic
 *  "None of the above") get nothing, and their CSS spans the full row. The
 *  picture belongs to its option, so a click on it picks the option like any
 *  other part of the row; only the corner button opens it fullscreen (Joe,
 *  2026-10-27: zooming in mid-choice was a surprise). The button is a
 *  role="button" span, not a <button>: a <label>'s control is its first
 *  labelable descendant, and this sits before the <input>, so a real button
 *  would steal every click on the row. */
export function tilePictureHtml(opt: QuestionOption, sessionId?: string): string {
  return opt.preview
    ? `<span class="prompt-opt__pic">${frameHtml(opt.preview, "prompt-opt__frame", sessionId)}<span class="prompt-opt__expand" role="button" tabindex="-1" title="View fullscreen" aria-label="View ${escapeHtml(opt.label)} fullscreen"><i class="ph ph-arrows-out" aria-hidden="true"></i></span></span>`
    : "";
}

/** The stage's picture is filled by sync(), not here, so a rebuild loads it
 *  once with the right option instead of loading a placeholder first. */
export function stageHtml(q: Question, qi: number, sessionId?: string): string {
  const opts = previewedOptions(q);
  const strip = isMobileViewport()
    ? `<div class="prompt-stage__strip">${opts.map((o, i) =>
        `<button type="button" class="prompt-stage__thumb" data-stage-i="${i}" aria-label="Preview ${escapeHtml(o.label)}" tabindex="-1">${frameHtml(o.preview!, "prompt-stage__thumb-frame", sessionId)}</button>`,
      ).join("")}</div>`
    : "";
  return `
    <div class="prompt-stage" data-stage="${qi}">
      <div class="prompt-stage__view">
        <iframe class="prompt-stage__frame" sandbox="" tabindex="-1" aria-hidden="true"></iframe>
        <span class="prompt-stage__hit"></span>
        ${EXPAND_ICON("prompt-stage__expand")}
      </div>
      <div class="prompt-stage__bar">
        <span class="prompt-stage__count"></span>
        <span class="prompt-stage__label"></span>
        <button type="button" class="btn btn-secondary prompt-stage__choose" hidden><i class="ph ph-check"></i> Choose this</button>
      </div>
      ${strip}
    </div>
  `;
}

function isPicked(sel: Selection | undefined, label: string): boolean {
  return sel instanceof Set ? sel.has(label) : sel === label;
}

function pickKey(sel: Selection | undefined): string {
  return sel instanceof Set ? [...sel].sort().join("\n") : sel ?? "";
}

export interface OptionPreviewsDeps {
  host: HTMLElement;
  questions: Question[];
  selections: Map<number, Selection>;
  choose: (qi: number, label: string) => void;
  /** Opens option `label` of question `qi` fullscreen. */
  expand: (qi: number, label: string) => void;
  /** The chat the question belongs to: routes local-image reads to the machine
   *  hosting it and keys the image cache. */
  sessionId?: string;
}

export interface OptionPreviews {
  /** Re-points every stage at its current option. Call after each render. */
  sync: () => void;
}

export function attachOptionPreviews(deps: OptionPreviewsDeps): OptionPreviews {
  const { host, questions, selections, choose, expand, sessionId } = deps;
  const viewing = new Map<number, string>();
  const lastPick = new Map<number, string>();
  let hover: { qi: number; label: string } | null = null;

  function shownLabel(qi: number, opts: QuestionOption[]): string {
    const sel = selections.get(qi);
    if (hover?.qi === qi) return hover.label;
    const viewed = viewing.get(qi);
    if (viewed) return viewed;
    return opts.find((o) => isPicked(sel, o.label))?.label ?? opts[0]!.label;
  }

  function syncStage(stage: HTMLElement): void {
    const qi = Number(stage.dataset.stage);
    const q = questions[qi];
    if (!q) return;
    const opts = previewedOptions(q);
    if (!opts.length) return;
    const sel = selections.get(qi);
    // A new pick (row tap, keyboard, Choose this) ends browsing: the stage
    // goes back to showing what is picked.
    const key = pickKey(sel);
    if (lastPick.get(qi) !== key) viewing.delete(qi);
    lastPick.set(qi, key);

    const label = shownLabel(qi, opts);
    const idx = Math.max(0, opts.findIndex((o) => o.label === label));
    const frame = stage.querySelector<HTMLIFrameElement>(".prompt-stage__frame");
    if (frame && frame.dataset.label !== label) {
      frame.dataset.label = label;
      frame.srcdoc = previewDocument(inlineLocalImages(opts[idx]!.preview!, sessionId));
    }
    const setText = (sel: string, text: string) => {
      const el = stage.querySelector<HTMLElement>(sel);
      if (el && el.textContent !== text) el.textContent = text;
    };
    setText(".prompt-stage__count", `${idx + 1}/${opts.length}`);
    setText(".prompt-stage__label", label);
    const phone = isMobileViewport();
    const chooseBtn = stage.querySelector<HTMLButtonElement>(".prompt-stage__choose");
    if (chooseBtn) chooseBtn.hidden = !phone || isPicked(sel, label);
    stage.querySelectorAll<HTMLElement>(".prompt-stage__thumb").forEach((t) =>
      t.classList.toggle("is-current", Number(t.dataset.stageI) === idx));
    host.querySelectorAll<HTMLInputElement>(`.prompt-panel[data-panel="${qi}"] .prompt-opt > input`).forEach((input) =>
      input.closest(".prompt-opt")?.classList.toggle(
        "is-previewing",
        phone && input.dataset.label === label && !isPicked(sel, label),
      ));
  }

  function sync(): void {
    host.querySelectorAll<HTMLElement>(".prompt-stage").forEach(syncStage);
  }

  // The frames were built before local images were read, so once they land
  // each frame is re-pointed in place (a full card render would drop focus in
  // the free-text field).
  function refreshFrames(): void {
    questions.forEach((q, qi) => {
      const opts = previewedOptions(q);
      host.querySelectorAll<HTMLInputElement>(`.prompt-panel[data-panel="${qi}"] .prompt-opt > input`).forEach((input) => {
        const opt = opts.find((o) => o.label === input.dataset.label);
        const frame = input.closest(".prompt-opt")?.querySelector<HTMLIFrameElement>(".prompt-opt__frame");
        if (opt && frame) frame.srcdoc = previewDocument(inlineLocalImages(opt.preview!, sessionId));
      });
      host.querySelectorAll<HTMLIFrameElement>(`.prompt-stage[data-stage="${qi}"] .prompt-stage__thumb`).forEach((t) => {
        const opt = opts[Number(t.dataset.stageI)];
        const frame = t.querySelector<HTMLIFrameElement>(".prompt-stage__thumb-frame");
        if (opt && frame) frame.srcdoc = previewDocument(inlineLocalImages(opt.preview!, sessionId));
      });
    });
    host.querySelectorAll<HTMLIFrameElement>(".prompt-stage__frame").forEach((f) => { delete f.dataset.label; });
    sync();
  }

  const fragments = questions.flatMap((q) => previewedOptions(q).map((o) => o.preview!));
  void prefetchLocalImages(fragments, sessionId).then((landed) => { if (landed) refreshFrames(); });

  function stageFor(qi: number): HTMLElement | null {
    return host.querySelector<HTMLElement>(`.prompt-stage[data-stage="${qi}"]`);
  }

  function step(qi: number, delta: number): void {
    const q = questions[qi];
    if (!q) return;
    const opts = previewedOptions(q);
    const cur = opts.findIndex((o) => o.label === shownLabel(qi, opts));
    const next = Math.min(opts.length - 1, Math.max(0, cur + delta));
    viewing.set(qi, opts[next]!.label);
    const stage = stageFor(qi);
    if (stage) syncStage(stage);
  }

  // Desktop only: a tap on a phone also fires mouseover, which would leave
  // the stage stuck on whatever was tapped last.
  host.addEventListener("mouseover", (e) => {
    if (isMobileViewport()) return;
    const target = e.target as HTMLElement;
    // Moving up from a row onto the picture keeps showing that row.
    if (target.closest(".prompt-stage")) return;
    const opt = target.closest<HTMLElement>(".prompt-panel--preview-stage .prompt-opt");
    const label = opt?.querySelector<HTMLInputElement>(":scope > input")?.dataset.label;
    const qi = Number(opt?.closest<HTMLElement>(".prompt-panel")?.dataset.panel);
    const q = Number.isFinite(qi) ? questions[qi] : undefined;
    const next = label && q && previewedOptions(q).some((o) => o.label === label) ? { qi, label } : null;
    if (next?.qi === hover?.qi && next?.label === hover?.label) return;
    hover = next;
    sync();
  });

  // Capture, and preventDefault: the tile's expand button sits inside the
  // row's <label>, whose default action would otherwise pick the option too.
  // A tile picture elsewhere is left alone so the label picks the option.
  host.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const pic = target.closest<HTMLElement>(".prompt-opt__expand");
    const hit = pic ? null : target.closest<HTMLElement>(".prompt-stage__hit");
    if (!pic && !hit) return;
    e.preventDefault();
    e.stopPropagation();
    if (pic) {
      const label = pic.closest(".prompt-opt")?.querySelector<HTMLInputElement>(":scope > input")?.dataset.label;
      const qi = Number(pic.closest<HTMLElement>(".prompt-panel")?.dataset.panel);
      if (label && Number.isFinite(qi)) expand(qi, label);
      return;
    }
    const qi = Number(hit!.closest<HTMLElement>(".prompt-stage")?.dataset.stage);
    const q = questions[qi];
    if (!q) return;
    expand(qi, shownLabel(qi, previewedOptions(q)));
  }, true);

  host.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const stage = target.closest<HTMLElement>(".prompt-stage");
    if (!stage) return;
    const qi = Number(stage.dataset.stage);
    const q = questions[qi];
    if (!q) return;
    const thumb = target.closest<HTMLElement>("[data-stage-i]");
    if (thumb) {
      const opt = previewedOptions(q)[Number(thumb.dataset.stageI)];
      if (opt) { viewing.set(qi, opt.label); syncStage(stage); }
      return;
    }
    if (target.closest(".prompt-stage__choose")) {
      const label = stage.querySelector<HTMLElement>(".prompt-stage__label")?.textContent ?? "";
      if (label) choose(qi, label);
    }
  });

  // Vertical swipe on the picture. The iframe would swallow the touch, so a
  // transparent .prompt-stage__hit layer sits over it to receive it.
  attachSwipe(host, {
    axis: "y",
    dropOnCrossAxis: false,
    startsOn: (target) => {
      const hit = target.closest(".prompt-stage__hit");
      if (!hit) return false;
      const qi = Number(hit.closest<HTMLElement>(".prompt-stage")?.dataset.stage);
      return Number.isFinite(qi);
    },
    onSwipe: (direction, startTarget) => {
      const qi = Number(startTarget.closest<HTMLElement>(".prompt-stage")?.dataset.stage);
      step(qi, direction);
    },
  });

  return { sync };
}
