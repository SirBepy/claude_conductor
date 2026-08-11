/**
 * Effort-level statusline chip + slider popover. Split out of
 * statusbar-popovers.ts (ai_todo 528) - pure move, no behavior change.
 */

import { escapeHtml } from "../../shared/escape-html";
import { EFFORTS } from "../../shared/effort-presets";
import { PopoverShell, wireCommitSlider } from "./statusbar-popover-shell";

export interface EffortOpenCtx {
  effort: string;
  sessionId: string | null;
  onEffortChange: ((effort: string) => void) | null;
  /** Persist + reflect the chosen effort, then close + re-render the chip. */
  onCommit: (effort: string) => void;
}

export class EffortPopover {
  private shell = new PopoverShell();

  get isOpen(): boolean { return this.shell.isOpen; }

  open(anchor: HTMLElement, ctx: EffortOpenCtx): void {
    this.shell.open(anchor, this.buildHtml(ctx.effort), {
      className: "sb-effort-popover",
      wire: (el) => {
        wireCommitSlider(el, ".sb-effort-slider", EFFORTS, {
          onChange: ctx.onEffortChange,
          sessionId: ctx.sessionId,
          invokeCmd: "set_session_effort",
          paramName: "effort",
          onCommit: ctx.onCommit,
        });
      },
    });
  }

  close(): void { this.shell.close(); }

  reanchor(anchor: HTMLElement): void { this.shell.reanchor(anchor); }

  private buildHtml(effort: string): string {
    const effortIdx = Math.max(0, EFFORTS.indexOf(effort as typeof EFFORTS[number]));
    return `
      <div class="sb-effort-popover-label">Effort</div>
      <input type="range" class="sb-effort-slider" min="0" max="${EFFORTS.length - 1}" step="1" value="${effortIdx}">
      <div class="sb-effort-stops">
        ${EFFORTS.map((e, i) => `<span class="sb-effort-stop${i === effortIdx ? " active" : ""}">${escapeHtml(e)}</span>`).join("")}
      </div>
    `;
  }
}
