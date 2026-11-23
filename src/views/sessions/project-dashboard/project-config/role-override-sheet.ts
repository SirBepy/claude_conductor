// The role sheet for ONE project's override of a kind, in the shared modal host.
// Settings > Models & providers draws the same sheet full-view for a payment
// group's rule; here the project rail has no room for it, so it opens as a
// popup around the same body (sheet-controller.ts) and only the save target differs.
import { html, render } from "lit-html";
import { closeHostCard, modalCardSlot, presentHostCard, setBackdropCancel } from "../../../../shared/modal";
import { escapeHtml } from "../../../../shared/escape-html";
import { PAYMENT_GROUPS } from "../../../../shared/routing-rules";
import type { RouteRule } from "../../../../types/ipc.generated";
import { routingKind } from "../../../../shared/routing-kinds";
import type { SheetCtx } from "../../../settings/subviews/models-providers/role-sheet";
import { mountSheetController } from "../../../settings/subviews/models-providers/sheet-controller";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import "../../../settings/subviews/models-providers/models-providers.css";

export interface OverrideSheetOpts {
  projectName: string;
  groupId: string;
  kind: string;
  /** The override as saved, or the payment group's rule for a kind not overridden yet (nothing is saved until a control changes). */
  rule: RouteRule;
  ctx(): SheetCtx;
  /** The override after a change; null once it is empty. */
  onRule(rule: RouteRule | null): void;
  /** "Back to the group": the project stops overriding this kind. */
  onReset(): void;
}

/** Resolves once the sheet is closed. */
export function openOverrideSheet(opts: OverrideSheetOpts): Promise<void> {
  const meta = routingKind(opts.kind) ?? { label: opts.kind, blurb: "", icon: "ph ph-sliders-horizontal" };
  const group = PAYMENT_GROUPS.find((g) => g.id === opts.groupId);
  const groupName = (group?.label.split(" ")[0] ?? opts.groupId).toLowerCase();
  const slot = modalCardSlot();
  return new Promise<void>((resolve) => {
    let ctl: ReturnType<typeof mountSheetController> | null = null;
    const close = (): void => {
      ctl?.dispose();
      setBackdropCancel(null);
      closeHostCard();
      resolve();
    };
    setBackdropCancel(close);
    void presentHostCard(() => {
      render(html`
        <div class="modal-card pd-modal wide view-settings-models-providers mp-pop" role="dialog" aria-modal="true" aria-label=${`${meta.label} for this project`}>
          <header class="modal-header mp-pop-head">
            <span class="mp-rb"><i class=${meta.icon}></i></span>
            <h3>${meta.label}<span class="pd-modal-sub">${meta.blurb}</span></h3>
          </header>
          <div class="modal-body mp-pop-body">
            <div class="mp-scope">${unsafeHTML(`<i class="ph ph-folder-simple"></i> Only for ${escapeHtml(opts.projectName)}. Other projects keep using the ${escapeHtml(groupName)} payment group.`)}</div>
            <div class="mp-pop-sheet"></div>
          </div>
          <footer class="modal-footer">
            <button type="button" class="btn-secondary mp-pop-reset" @click=${() => { opts.onReset(); close(); }}><i class="ph ph-arrow-counter-clockwise"></i> Back to the group</button>
            <button type="button" class="btn-primary mp-pop-done" @click=${close}>Done</button>
          </footer>
        </div>`, slot);
      const body = slot.querySelector<HTMLElement>(".mp-pop-sheet");
      if (body) ctl = mountSheetController(body, { kind: opts.kind, rule: opts.rule, ctx: opts.ctx, onRule: opts.onRule });
    });
  });
}
