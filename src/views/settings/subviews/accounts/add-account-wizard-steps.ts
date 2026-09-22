// Per-step render + wire logic for the add-account wizard
// (add-account-wizard.ts). Split out so each wizard step (create / cookie /
// login / finalize) owns its own render+wire pair against an explicit
// `WizardState` object instead of all four being nested closures inside one
// giant function. `add-account-wizard.ts` remains the only caller: it owns
// the state object, the IPC orchestration (doCreate/doCaptureCookie/etc.),
// and wires each step's callbacks to that orchestration.

import { escapeHtml } from "../../../../shared/escape-html";
import type { OauthAccountInfo } from "../../../../shared/api";
import { tierLabel, formatElapsed } from "./wizard-logic";
import { renderAppearancePicker } from "./appearance-picker";

export type Step = "create" | "cookie" | "login" | "finalize";

/** All mutable state for one wizard run, in place of the ~15 separate `let`
 * bindings the pre-split version closed over. Passed by reference into every
 * render/wire function below - they mutate fields directly rather than each
 * owning a private copy. */
export interface WizardState {
  step: Step;
  busy: boolean;
  error: string | null;

  // create step
  nameInput: string;

  // session
  sessionId: string | null;
  adoptedExisting: boolean;
  existingIdentity: OauthAccountInfo | null;
  hasCredentials: boolean;
  configDir: string;

  // cookie (browser login) step
  verifiedIdentity: OauthAccountInfo | null;
  cookieCaptured: boolean;
  cookieError: string | null;
  browserSkipped: boolean;

  // CLI login step
  terminalTitle: string | null;
  misdirected: string | null;
  credentialsNoProfile: boolean;
  manualCheckPending: boolean;
  pollTimer: ReturnType<typeof setInterval> | null;
  loginStartedAt: number;
  elapsedMs: number;
  loginFailure: { kind: "mismatch" | "duplicate" | "timeout"; message: string } | null;

  // finalize step
  label: string;
  icon: string;
  colour: string;
}

/** Callbacks each step's wiring may invoke. `render` re-renders the whole
 * wizard (steps that only tweak local DOM, like the create step's name
 * input, skip it and patch the DOM directly instead). The rest hand off to
 * add-account-wizard.ts's IPC/orchestration functions. */
export interface WizardCallbacks {
  render: () => void;
  onCreate: () => void;
  onCapture: () => void;
  onSkipBrowser: () => void;
  onCheckNow: () => void;
  onBackToBrowser: () => void;
  onFinalize: () => void;
}

export function renderCreateStep(state: WizardState): string {
  return `
    <div class="field">
      <label>Account name</label>
      <input type="text" class="aaw-input" id="aaw-name" placeholder="e.g. Work" value="${escapeHtml(state.nameInput)}" ${state.busy ? "disabled" : ""}>
    </div>
    ${state.error ? `<div class="aaw-error"><i class="ph ph-warning-circle"></i> ${escapeHtml(state.error)}</div>` : ""}
    <div class="wz-actions">
      <span class="muted" style="font-size: var(--fs-micro)">Next: log into claude.ai in a browser window</span>
      <button class="btn primary" id="aaw-create-btn" ${state.busy || !state.nameInput.trim() ? "disabled" : ""}>
        ${state.busy ? `<i class="ph ph-spinner aaw-spin"></i> Creating...` : "Create"}
      </button>
    </div>
  `;
}

export function wireCreateStep(overlay: HTMLElement, state: WizardState, cb: WizardCallbacks): void {
  const nameEl = overlay.querySelector<HTMLInputElement>("#aaw-name");
  nameEl?.addEventListener("input", () => {
    state.nameInput = nameEl.value;
    const btn = overlay.querySelector<HTMLButtonElement>("#aaw-create-btn");
    if (btn) btn.disabled = state.busy || !state.nameInput.trim();
  });
  nameEl?.focus();
  overlay.querySelector<HTMLButtonElement>("#aaw-create-btn")?.addEventListener("click", cb.onCreate);
  nameEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !state.busy && state.nameInput.trim()) cb.onCreate();
  });
}

export function renderCookieStep(state: WizardState): string {
  const adoptHint = state.adoptedExisting && state.existingIdentity
    ? `<div class="aaw-note"><i class="ph ph-info"></i> This profile folder already existed (logged in as ${escapeHtml(state.existingIdentity.emailAddress)}) - log into the SAME account in the browser.</div>`
    : "";
  const identityBlock = state.verifiedIdentity
    ? `
    <div class="detected">
      <span class="av"><i class="ph ph-check-circle"></i></span>
      <span class="info">
        <div class="nm">${escapeHtml(state.verifiedIdentity.emailAddress)}</div>
        <div class="em">${escapeHtml(state.verifiedIdentity.organizationName ?? "")}${state.verifiedIdentity.organizationName ? " &middot; " : ""}${escapeHtml(tierLabel(state.verifiedIdentity.organizationType))}</div>
      </span>
      <span class="ok"><i class="ph ph-check-circle"></i> verified</span>
    </div>`
    : "";
  return `
    ${adoptHint}
    ${identityBlock}
    <p class="aaw-explain">
      Log into claude.ai as this account in the browser window. That single login
      identifies the account AND connects usage tracking.
    </p>
    ${state.cookieError ? `<div class="aaw-error"><i class="ph ph-warning-circle"></i> ${escapeHtml(state.cookieError)}</div>` : ""}
    ${state.cookieCaptured ? `<div class="aaw-note"><i class="ph ph-check-circle"></i> Browser login verified.</div>` : ""}
    <div class="wz-actions">
      <button class="btn" id="aaw-skip-browser-btn" ${state.busy ? "disabled" : ""}>Use terminal /login instead</button>
      <button class="btn primary" id="aaw-capture-btn" ${state.busy ? "disabled" : ""}>
        ${state.busy ? `<i class="ph ph-spinner aaw-spin"></i> Waiting on browser...` : state.cookieCaptured ? "Continue" : "Open browser login"}
      </button>
    </div>
  `;
}

export function wireCookieStep(overlay: HTMLElement, _state: WizardState, cb: WizardCallbacks): void {
  overlay.querySelector<HTMLButtonElement>("#aaw-capture-btn")?.addEventListener("click", cb.onCapture);
  overlay.querySelector<HTMLButtonElement>("#aaw-skip-browser-btn")?.addEventListener("click", cb.onSkipBrowser);
}

export function renderLoginStep(state: WizardState): string {
  if (state.loginFailure) {
    return `
      <div class="aaw-error"><i class="ph ph-warning-circle"></i> ${escapeHtml(state.loginFailure.message)}</div>
      <div class="wz-actions"><span></span><span></span></div>
    `;
  }

  const targetLine = state.verifiedIdentity
    ? `Log into <b>${escapeHtml(state.verifiedIdentity.emailAddress)}</b> - the same account as the browser step.`
    : `Pick the right account when the browser opens.`;
  const misdirectedNote = state.misdirected
    ? `<div class="aaw-warn"><i class="ph ph-warning"></i> <span>A login just landed in ${escapeHtml(state.misdirected)}, not in this account's profile. You probably used a different terminal - type /login in the window titled "${escapeHtml(state.terminalTitle ?? "Claude login")}".</span></div>`
    : "";
  const credentialsNoProfileNote = state.credentialsNoProfile && !state.verifiedIdentity
    ? `<div class="aaw-warn"><i class="ph ph-warning"></i> <span>This profile already has valid stored credentials, but Claude Code never recorded which account they belong to - and it only does that during /login itself, so waiting won't help. Go back to the browser login to confirm the account instead.</span></div>`
    : "";
  const notDetectedNote = state.manualCheckPending && !state.credentialsNoProfile
    ? `<div class="aaw-warn"><i class="ph ph-warning"></i> <span>No login detected yet in <code>${escapeHtml(state.configDir)}</code>. Make sure /login finished in the window titled "${escapeHtml(state.terminalTitle ?? "Claude login")}".</span></div>`
    : "";
  return `
    ${misdirectedNote}
    ${credentialsNoProfileNote}
    ${notDetectedNote}
    <div class="aaw-waiting">
      <i class="ph ph-spinner aaw-spin"></i>
      <div>Run <code>/login</code> in the terminal that just opened${state.terminalTitle ? ` (window titled "${escapeHtml(state.terminalTitle)}")` : ""}.</div>
      <div>${targetLine}</div>
      <div class="muted">This finishes on its own once the login lands. Waiting... ${formatElapsed(state.elapsedMs)}</div>
    </div>
    <div class="wz-actions">
      <button class="btn" id="aaw-back-to-browser-btn">${state.browserSkipped ? "Use browser login instead" : "Back to browser login"}</button>
      <button class="btn" id="aaw-checknow-btn">I've logged in - check now</button>
    </div>
  `;
}

export function wireLoginStep(overlay: HTMLElement, _state: WizardState, cb: WizardCallbacks): void {
  overlay.querySelector<HTMLButtonElement>("#aaw-checknow-btn")?.addEventListener("click", cb.onCheckNow);
  overlay.querySelector<HTMLButtonElement>("#aaw-back-to-browser-btn")?.addEventListener("click", cb.onBackToBrowser);
}

export function renderFinalizeStep(state: WizardState): string {
  const identitySummary = state.verifiedIdentity
    ? `
    <div class="detected">
      <span class="av"><i class="ph ph-check-circle"></i></span>
      <span class="info">
        <div class="nm">${escapeHtml(state.verifiedIdentity.emailAddress)}</div>
        <div class="em">${escapeHtml(tierLabel(state.verifiedIdentity.organizationType))}</div>
      </span>
      <span class="ok"><i class="ph ph-check-circle"></i> logged in</span>
    </div>`
    : "";
  return `
    ${identitySummary}
    <div id="aaw-appearance-picker"></div>
    ${state.error ? `<div class="aaw-error"><i class="ph ph-warning-circle"></i> ${escapeHtml(state.error)}</div>` : ""}
    <div class="wz-actions">
      <span></span>
      <button class="btn primary" id="aaw-finalize-btn" ${state.busy || !state.label.trim() ? "disabled" : ""}>
        ${state.busy ? `<i class="ph ph-spinner aaw-spin"></i> Adding...` : `Add ${escapeHtml(state.label.trim() || "account")}`}
      </button>
    </div>
  `;
}

export function wireFinalizeStep(overlay: HTMLElement, state: WizardState, cb: WizardCallbacks): void {
  const pickerContainer = overlay.querySelector<HTMLElement>("#aaw-appearance-picker");
  // Self-managed: the picker re-renders only its own subtree on icon/colour
  // picks, so nothing else in the finalize step needs to react - no
  // onChange side effect required here (contrast edit-account-modal.ts,
  // which uses onChange to keep its tab-underline colour in sync).
  if (pickerContainer) renderAppearancePicker(pickerContainer, state, () => {});
  overlay.querySelector<HTMLButtonElement>("#aaw-finalize-btn")?.addEventListener("click", cb.onFinalize);
}
