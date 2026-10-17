// Visual option previews on the question card. Layout, settled with Joe on
// 2026-10-17 over a mockup of this card:
// - desktop, 1-3 previewed options: side-by-side tiles, picture on top;
// - desktop 4+, or any phone: one big stage above the normal option list.
// On desktop the stage follows hover, then the pick. On phone there is no
// hover, so "viewing" is its own state: swipe the picture up/down (sideways
// stays question paging, question-swipe.ts) or tap a filmstrip thumbnail,
// and "Choose this" picks what is shown. Tapping a row still picks directly.

import { escapeHtml } from "../../../shared/escape-html";
import { isMobileViewport } from "../../../shared/mobile-viewport";
import { previewDocument } from "./option-preview-doc";
import type { Question, QuestionOption, Selection } from "./types";

export const TILE_MAX = 3;
const SWIPE_PX = 40;

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
function frameHtml(fragment: string, cls: string): string {
  return `<iframe class="${cls}" sandbox="" tabindex="-1" aria-hidden="true" srcdoc="${escapeHtml(previewDocument(fragment))}"></iframe>`;
}

/** The picture on top of a tile row. Rows without a preview (the synthetic
 *  "None of the above") get nothing, and their CSS spans the full row. */
export function tilePictureHtml(opt: QuestionOption): string {
  return opt.preview ? `<span class="prompt-opt__pic">${frameHtml(opt.preview, "prompt-opt__frame")}</span>` : "";
}

/** The stage's picture is filled by sync(), not here, so a rebuild loads it
 *  once with the right option instead of loading a placeholder first. */
export function stageHtml(q: Question, qi: number): string {
  const opts = previewedOptions(q);
  const strip = isMobileViewport()
    ? `<div class="prompt-stage__strip">${opts.map((o, i) =>
        `<button type="button" class="prompt-stage__thumb" data-stage-i="${i}" aria-label="Preview ${escapeHtml(o.label)}" tabindex="-1">${frameHtml(o.preview!, "prompt-stage__thumb-frame")}</button>`,
      ).join("")}</div>`
    : "";
  return `
    <div class="prompt-stage" data-stage="${qi}">
      <div class="prompt-stage__view">
        <iframe class="prompt-stage__frame" sandbox="" tabindex="-1" aria-hidden="true"></iframe>
        <span class="prompt-stage__hit"></span>
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
}

export interface OptionPreviews {
  /** Re-points every stage at its current option. Call after each render. */
  sync: () => void;
}

export function attachOptionPreviews(deps: OptionPreviewsDeps): OptionPreviews {
  const { host, questions, selections, choose } = deps;
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
      frame.srcdoc = previewDocument(opts[idx]!.preview!);
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
  let touch: { qi: number; x: number; y: number } | null = null;
  host.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    const hit = (e.target as Element).closest?.(".prompt-stage__hit");
    const qi = Number(hit?.closest<HTMLElement>(".prompt-stage")?.dataset.stage);
    touch = hit && t && e.touches.length === 1 && Number.isFinite(qi) ? { qi, x: t.clientX, y: t.clientY } : null;
  }, { passive: true });
  host.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    if (!touch || !t) return;
    // Stops the panel scrolling under a swipe meant for the picture.
    if (Math.abs(t.clientY - touch.y) > Math.abs(t.clientX - touch.x) && e.cancelable) e.preventDefault();
  }, { passive: false });
  host.addEventListener("touchend", (e) => {
    const t = e.changedTouches[0];
    const start = touch;
    touch = null;
    if (!start || !t) return;
    const dy = t.clientY - start.y;
    if (Math.abs(dy) < SWIPE_PX || Math.abs(dy) < Math.abs(t.clientX - start.x)) return;
    step(start.qi, dy < 0 ? 1 : -1);
  });
  host.addEventListener("touchcancel", () => { touch = null; });

  return { sync };
}
