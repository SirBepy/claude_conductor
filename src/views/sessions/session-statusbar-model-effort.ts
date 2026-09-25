// Model + effort statusline-chip state, consolidated out of SessionStatusbar
// (todo 891) the same way git-card/drain-popover already own their own
// state: the popover instance, the anchor a background re-render must
// reanchor to, and the value currently shown on the chip. Pure move - the
// popover-open payloads, commit callbacks and read-only gate are unchanged,
// only relocated behind toggleModelPopover/toggleEffortPopover so
// SessionStatusbar hands in the cross-cutting bits (sessionId, the meta
// fallback model, the close-others sweep, the re-render) it alone owns.

import { ModelPopover } from "./model-popover";
import { EffortPopover } from "./effort-popover";

export interface ModelEffortOptions {
  effort: string;
  sessionModel: string | null;
  readOnly: boolean;
  onEffortChange: ((effort: string) => void) | null;
  onModelChange: ((model: string) => void) | null;
}

export class ModelEffortState {
  sessionModel: string | null;
  effort: string;
  readOnlyEffort: boolean;
  private onEffortChange: ((effort: string) => void) | null;
  private onModelChange: ((model: string) => void) | null;
  readonly modelPopover = new ModelPopover();
  readonly effortPopover = new EffortPopover();
  /** Whatever last opened the model/effort popover - a statusline chip, or the
   *  pane header's config text. Which one it was decides whether a re-render
   *  has to re-bind the anchor; see session-statusbar-popovers.ts's
   *  reanchorConfigPopover. */
  modelAnchor: HTMLElement | null = null;
  effortAnchor: HTMLElement | null = null;

  constructor(opts: ModelEffortOptions) {
    this.effort = opts.effort;
    this.sessionModel = opts.sessionModel;
    this.readOnlyEffort = opts.readOnly;
    this.onEffortChange = opts.onEffortChange;
    this.onModelChange = opts.onModelChange;
  }

  /** Open (or dismiss) the model slider on `anchor`. Public because the pane
   *  header prints model/effort too and routes its own clicks here, so both
   *  surfaces share one popover and one commit path. `anchor` may sit outside
   *  the statusbar's own container. `closeOthers` sweeps every chip popover
   *  first (at most one is ever open); `rerender` repaints after a commit. */
  toggleModelPopover(
    anchor: HTMLElement,
    sessionId: string | null,
    fallbackModel: string | null,
    closeOthers: () => void,
    rerender: () => void,
  ): void {
    const wasOpen = this.modelPopover.isOpen;
    closeOthers();
    if (wasOpen) return;
    this.modelAnchor = anchor;
    this.modelPopover.open(anchor, {
      model: this.sessionModel ?? fallbackModel ?? "",
      sessionId,
      onModelChange: this.onModelChange ?? undefined,
      onCommit: (next) => {
        this.sessionModel = next;
        this.modelPopover.close();
        rerender();
      },
    });
  }

  /** Effort's counterpart to `toggleModelPopover`. A read-only (external)
   *  session has no effort to set, so the click is swallowed here rather than
   *  in each caller. */
  toggleEffortPopover(
    anchor: HTMLElement,
    sessionId: string | null,
    closeOthers: () => void,
    rerender: () => void,
  ): void {
    if (this.readOnlyEffort) return;
    const wasOpen = this.effortPopover.isOpen;
    closeOthers();
    if (wasOpen) return;
    this.effortAnchor = anchor;
    this.effortPopover.open(anchor, {
      effort: this.effort,
      sessionId,
      onEffortChange: this.onEffortChange,
      onCommit: (next) => { this.effort = next; this.effortPopover.close(); rerender(); },
    });
  }

  /** Returns true when the value actually changed, so the caller knows
   *  whether a re-render is owed. */
  setReadOnlyEffort(readOnly: boolean): boolean {
    if (this.readOnlyEffort === readOnly) return false;
    this.readOnlyEffort = readOnly;
    return true;
  }

  /** Switches the model chip from draft-local editing to live editing once the
   *  real agent process has spawned (a draft's onModelChange must not survive
   *  into the started session, or picking a model would only update local
   *  state instead of calling set_session_model). Returns true when a
   *  re-render is owed. */
  disableModelEdit(): boolean {
    if (!this.onModelChange) return false;
    this.onModelChange = null;
    return true;
  }
}
