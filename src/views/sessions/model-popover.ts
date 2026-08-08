/**
 * Model statusline chip + slider popover. Split out of
 * statusbar-popovers.ts (ai_todo 528) - pure move, no behavior change.
 */

import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { readModels, modelDisplayLabel, modelFamilyFromId } from "../../shared/effort-presets";
import { PopoverShell } from "./statusbar-popover-shell";

export interface ModelOpenCtx {
  model: string;
  sessionId: string | null;
  /** Present only for a not-yet-started (draft) session: commits locally
   *  instead of round-tripping through set_session_model. */
  onModelChange?: (model: string) => void;
  /** Persist + reflect the chosen model, then close + re-render the chip. */
  onCommit: (model: string) => void;
}

export class ModelPopover {
  private shell = new PopoverShell();

  get isOpen(): boolean { return this.shell.isOpen; }

  open(anchor: HTMLElement, ctx: ModelOpenCtx): void {
    if (!ctx.onModelChange && !ctx.sessionId) {
      if (!ctx.model) { this.shell.close(); return; }
      this.shell.open(anchor, `
        <div class="sb-model-popover-name">${escapeHtml(ctx.model)}</div>
      `, { className: "sb-model-popover" });
      return;
    }
    const models = readModels({});
    const isDraft = !!ctx.onModelChange;
    // ctx.model is a full API id (e.g. "claude-sonnet-4-5-20250929") once a turn
    // has landed, but `models` is the canonical family list - compare families
    // or the active-stop lookup below always misses and defaults to index 0.
    this.shell.open(anchor, this.buildEditableHtml(models, modelFamilyFromId(ctx.model), isDraft), {
      className: "sb-model-popover",
      wire: (el) => {
        const slider = el.querySelector<HTMLInputElement>(".sb-model-slider");
        slider?.addEventListener("change", () => {
          const next = models[Number(slider.value)];
          if (!next) return;
          if (ctx.onModelChange) {
            ctx.onModelChange(next);
            ctx.onCommit(next);
            return;
          }
          if (!ctx.sessionId) return;
          const sid = ctx.sessionId;
          void invoke<void>("set_session_model", { sessionId: sid, model: next })
            .then(() => ctx.onCommit(next))
            .catch((err) => console.error("[statusbar] set_session_model failed", err));
        });
      },
    });
  }

  close(): void { this.shell.close(); }

  reanchor(anchor: HTMLElement): void { this.shell.reanchor(anchor); }

  private buildEditableHtml(models: string[], model: string, isDraft: boolean): string {
    const idx = Math.max(0, models.indexOf(model));
    const stops = models.map((m, i) => `
      <span class="sb-model-stop${i === idx ? " active" : ""}">${escapeHtml(modelDisplayLabel(m))}</span>
    `).join("");
    const hint = isDraft ? "Applies when this chat starts." : "Applies to your next message.";
    return `
      <div class="sb-model-popover-name">Model</div>
      <input type="range" class="sb-model-slider" min="0" max="${models.length - 1}" step="1" value="${idx}">
      <div class="sb-model-stops">${stops}</div>
      <div class="sb-model-popover-hint">${hint}</div>
    `;
  }
}
