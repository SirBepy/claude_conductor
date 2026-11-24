// Wires one role sheet body: paints `sheetBodyHtml`, turns each control change
// into the next rule through `applySheetChange`, and keeps the summary strip,
// the folds and the free-text model field in step. Settings > Models & providers
// (a payment group's rule) and a project's rail (one override) both mount it, so
// the two sheets cannot drift apart; each owns where the rule is saved.

import type { RouteRule } from "../../../../types/ipc.generated";
import { normalizeRule } from "../../../../shared/routing-rules";
import { applySheetChange, sheetBodyHtml, summaryHtml, type SheetCtx } from "./role-sheet";

export interface SheetController {
  rule(): RouteRule;
  /** Replaces the working rule (a reset) and redraws; `onRule` is not called. */
  setRule(rule: RouteRule): void;
  dispose(): void;
}

export interface SheetControllerOpts {
  kind: string;
  rule: RouteRule;
  ctx(): SheetCtx;
  /** The rule after a change that took effect: null when it is now empty. A refused model id never gets here. */
  onRule(rule: RouteRule | null): void;
}

export function mountSheetController(body: HTMLElement, opts: SheetControllerOpts): SheetController {
  let rule = opts.rule;
  let otherOpen = false;

  const paint = (): void => {
    const scroller = body.closest<HTMLElement>(".view-body, .modal-body");
    const top = scroller?.scrollTop ?? 0;
    body.innerHTML = sheetBodyHtml(opts.kind, rule, opts.ctx(), otherOpen);
    if (scroller) scroller.scrollTop = top;
  };

  const onChange = (e: Event): void => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    if (!el.id?.startsWith("sh-")) return;
    const res = applySheetChange(rule, el.id, el.value, (el as HTMLInputElement).checked === true, opts.ctx());
    const err = body.querySelector<HTMLElement>("#sh-model-error");
    if (err) { err.hidden = !res.modelError; err.textContent = res.modelError ?? ""; }
    if (res.modelError) return;
    // Opening the free-text field changes no rule: saving then would turn a project's untouched seed into an override.
    const changed = res.rule !== rule;
    rule = res.rule;
    if (res.otherOpen !== undefined) {
      otherOpen = res.otherOpen;
      body.querySelector("#sh-other-fold")?.classList.toggle("on", res.otherOpen);
    }
    if (changed) opts.onRule(normalizeRule(rule));
    if (res.redraw) paint();
    else if (el.id === "sh-flex") body.querySelector("#sh-fold")?.classList.toggle("on", (el as HTMLInputElement).checked);
    const sum = body.querySelector("#sh-sum");
    if (sum) sum.innerHTML = summaryHtml(rule, opts.ctx(), opts.kind);
  };
  body.addEventListener("change", onChange);
  paint();

  return {
    rule: () => rule,
    setRule: (next) => { rule = next; otherOpen = false; paint(); },
    dispose: () => body.removeEventListener("change", onChange),
  };
}
