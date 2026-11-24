// The markup of the "Who does what" tab and its role sheet, kept apart from the
// mount in models-providers.ts so the Accounts page can draw both without
// loading the tab's logic until it opens.

import { html } from "lit-html";
import { PAYMENT_GROUPS } from "../../../../shared/routing-rules";

/** What the page keeps once the tab is mounted. */
export interface WhoHandle {
  /** Re-measures the panel height and the tab indicator; call once the tab is visible. */
  fit: () => void;
  dispose: () => void;
}

const TIP = "A chat's own pick, then the project's routing, then its payment group's roles, then the default.";

export function whoTemplate() {
  return html`
    <p class="acc-explainer">Which account and model each kind of job runs on, per payment group. ${TIP}</p>
    <div class="mp-tabs" id="mp-tabs" role="tablist">
      ${PAYMENT_GROUPS.map((g, i) => html`<button type="button" class="mp-tab${i === 0 ? " on" : ""}" role="tab" id="mp-tab-${g.id}" aria-selected=${i === 0 ? "true" : "false"} aria-controls="mp-panel-${g.id}" data-group=${g.id}><i class="ph ${g.icon}"></i> ${g.label} <span class="cnt" id="mp-cnt-${g.id}"></span></button>`)}
      <span class="mp-ind" id="mp-ind"></span>
    </div>
    <div class="mp-panels" id="mp-panels">
      ${PAYMENT_GROUPS.map((g, i) => html`<div class="mp-panel${i === 0 ? " on" : ""}" id="mp-panel-${g.id}" role="tabpanel" aria-labelledby="mp-tab-${g.id}" ?inert=${i !== 0}>
        <div class="mp-projects" id="mp-proj-${g.id}"></div>
        <div id="mp-cards-${g.id}"></div>
      </div>`)}
    </div>
    <div class="mp-foot"><i class="ph ph-info"></i> Helpers a chat starts inside itself use that chat's account.</div>`;
}

/** The slide-over that edits one role; a sibling of the page so the page can go inert behind it. */
export function sheetTemplate() {
  return html`
    <div class="mp-sheet" id="mp-sheet" aria-hidden="true" inert role="dialog" aria-label="Role settings">
      <div class="view-header">
        <button class="icon-btn" id="mp-sh-back" title="Back" aria-label="Back"><i class="ph ph-arrow-left"></i></button>
        <div class="hd"><span class="mp-rb" id="mp-sh-rb"></span><div><h2 id="mp-sh-title"></h2><small id="mp-sh-sub"></small></div></div>
      </div>
      <div class="view-body"><div class="view-body-inner mp-inner mp-inner-narrow">
        <div class="mp-scope" id="mp-sh-scope"></div>
        <div id="mp-sh-body"></div>
      </div></div>
      <div class="mp-sheet-foot">
        <button class="btn-secondary" id="mp-sh-reset"><i class="ph ph-arrow-counter-clockwise"></i> Reset to default</button>
        <button class="btn-primary" id="mp-sh-done">Done</button>
      </div>
    </div>`;
}
