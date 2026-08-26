// Add-account wizard modal (multi-account milestone 01 frontend).
// Browser-first flow (2026-07-08): Create -> Browser login (cookie +
// identity via GET /api/account) -> CLI login only when the profile dir has
// no credentials yet (spawned on demand) -> Finalize. Drives the backend IPC
// in src-tauri/src/ipc/accounts.rs: add_account_create ->
// add_account_capture_cookie -> optional add_account_start_cli_login + poll
// add_account_check_login -> add_account_finalize, with add_account_cancel on
// any bail-out. See docs/multi-account/01-account-identity.md.
//
// `openAddAccountWizard` itself is a thin orchestrator: create a `WizardCtx`
// (state + overlay + resolve), wire it up, and hand rendering off to the rest
// of this file's module-level functions - all keyed off that ctx rather than
// closing over locals inside one giant function. The per-step render + DOM
// wiring pairs live in add-account-wizard-steps.ts (one pair per wizard
// step, keyed off `state` the same way).

import { escapeHtml } from "../../../../shared/escape-html";
import { api } from "../../../../shared/api";
import type { Account } from "../../../../shared/api";
import { askConfirm } from "../../../../shared/confirm";
import { registerOverlayBack } from "../../../../shared/back-button";
import "./add-account-wizard.css";
import {
  ICON_POOL,
  COLOUR_POOL,
  LOGIN_POLL_INTERVAL_MS,
  pickAvailableIcon,
  prefillLabel,
  isLoginTimedOut,
  describeLoginOutcome,
} from "./wizard-logic";
import {
  renderCreateStep,
  renderCookieStep,
  renderLoginStep,
  renderFinalizeStep,
  wireCreateStep,
  wireCookieStep,
  wireLoginStep,
  wireFinalizeStep,
  type Step,
  type WizardState,
  type WizardCallbacks,
} from "./add-account-wizard-steps";

/** Everything one wizard run needs, in place of the pile of closure locals
 * the pre-split version carried. `onKey` is filled in right after
 * construction (it needs to close over `ctx` itself to call `requestClose`). */
interface WizardCtx {
  state: WizardState;
  overlay: HTMLDivElement;
  usedIcons: string[];
  resolve: (result: Account | null) => void;
  onKey: (e: KeyboardEvent) => void;
  /** Disposer for the back-button.ts overlay-stack registration (phone
   * hardware-back). Filled in right after construction alongside `onKey`. */
  disposeBack: () => void;
}

function createInitialState(): WizardState {
  return {
    step: "create",
    busy: false,
    error: null,

    nameInput: "",

    sessionId: null,
    adoptedExisting: false,
    existingIdentity: null,
    hasCredentials: false,
    configDir: "",

    verifiedIdentity: null,
    cookieCaptured: false,
    cookieError: null,
    browserSkipped: false,

    terminalTitle: null,
    misdirected: null,
    credentialsNoProfile: false,
    manualCheckPending: false,
    pollTimer: null,
    loginStartedAt: 0,
    elapsedMs: 0,
    loginFailure: null,

    label: "",
    icon: "",
    colour: COLOUR_POOL[0]!,
  };
}

function stopPolling(ctx: WizardCtx): void {
  if (ctx.state.pollTimer !== null) {
    clearInterval(ctx.state.pollTimer);
    ctx.state.pollTimer = null;
  }
}

async function cancelSession(ctx: WizardCtx): Promise<void> {
  if (!ctx.state.sessionId) return;
  try { await api.addAccountCancel(ctx.state.sessionId); }
  catch (e) { console.error("[add-account-wizard] cancel failed", e); }
}

function close(ctx: WizardCtx, result: Account | null): void {
  stopPolling(ctx);
  ctx.disposeBack();
  ctx.overlay.remove();
  document.removeEventListener("keydown", ctx.onKey);
  ctx.resolve(result);
}

/** Close via X / Escape. Past step 1 there is real progress (a profile dir,
 * possibly a login) - confirm before discarding it. */
function requestClose(ctx: WizardCtx): void {
  void (async () => {
    if (ctx.state.step !== "create") {
      const ok = await askConfirm(
        "Discard this account setup?\nProgress so far (logins included) will be thrown away.",
        { confirmLabel: "Discard", cancelLabel: "Keep going" },
      );
      if (!ok) return;
    }
    stopPolling(ctx);
    void cancelSession(ctx).then(() => close(ctx, null));
  })();
}

function stepNumber(s: Step): number {
  return { create: 1, cookie: 2, login: 3, finalize: 4 }[s];
}

function stepsHtml(state: WizardState): string {
  const order: { key: Step; label: string }[] = [
    { key: "create", label: "Create" },
    { key: "cookie", label: "Browser login" },
    { key: "login", label: "CLI login" },
    { key: "finalize", label: "Finalize" },
  ];
  const curNum = stepNumber(state.step);
  return order
    .map((o, i) => {
      const n = stepNumber(o.key);
      // The CLI step gets skipped entirely when credentials already exist -
      // render it as done once we're past it either way.
      const cls = n < curNum ? "done" : n === curNum ? "cur" : "";
      const inner = n < curNum ? `<i class="ph ph-check"></i>` : String(n);
      const line = i < order.length - 1 ? `<span class="line"></span>` : "";
      return `<span class="st ${cls}"><span class="n">${inner}</span> ${escapeHtml(o.label)}</span>${line}`;
    })
    .join("");
}

function bodyHtml(state: WizardState): string {
  switch (state.step) {
    case "create": return renderCreateStep(state);
    case "cookie": return renderCookieStep(state);
    case "login": return renderLoginStep(state);
    case "finalize": return renderFinalizeStep(state);
  }
}

function buildCallbacks(ctx: WizardCtx): WizardCallbacks {
  return {
    render: () => render(ctx),
    onCreate: () => void doCreate(ctx),
    onCapture: () => {
      if (ctx.state.cookieCaptured) { advanceAfterIdentity(ctx); return; }
      void doCaptureCookie(ctx);
    },
    onSkipBrowser: () => {
      ctx.state.browserSkipped = true;
      void gotoCliLogin(ctx);
    },
    onCheckNow: () => {
      ctx.state.manualCheckPending = true;
      void pollLogin(ctx);
    },
    onBackToBrowser: () => {
      stopPolling(ctx);
      ctx.state.loginFailure = null;
      ctx.state.step = "cookie";
      render(ctx);
    },
    onFinalize: () => void doFinalize(ctx),
  };
}

function render(ctx: WizardCtx): void {
  ctx.overlay.innerHTML = `
    <div class="wizard" role="dialog" aria-modal="true" aria-label="Add a Claude account">
      <div class="wz-head">
        <div class="wz-head-row">
          <div class="t">Add a Claude account</div>
          <button class="icon-btn-sq wz-close" id="aaw-close-btn" title="Close" aria-label="Close"><i class="ph ph-x"></i></button>
        </div>
        <div class="wz-steps">${stepsHtml(ctx.state)}</div>
      </div>
      <div class="wz-body">${bodyHtml(ctx.state)}</div>
    </div>
  `;
  attach(ctx);
}

function attach(ctx: WizardCtx): void {
  ctx.overlay.querySelector<HTMLButtonElement>("#aaw-close-btn")?.addEventListener("click", () => requestClose(ctx));

  const callbacks = buildCallbacks(ctx);
  switch (ctx.state.step) {
    case "create": wireCreateStep(ctx.overlay, ctx.state, callbacks); break;
    case "cookie": wireCookieStep(ctx.overlay, ctx.state, callbacks); break;
    case "login": wireLoginStep(ctx.overlay, ctx.state, callbacks); break;
    case "finalize": wireFinalizeStep(ctx.overlay, ctx.state, callbacks); break;
  }
}

async function doCreate(ctx: WizardCtx): Promise<void> {
  const { state } = ctx;
  state.busy = true;
  state.error = null;
  render(ctx);
  try {
    const session = await api.addAccountCreate(state.nameInput.trim(), null);
    state.sessionId = session.session_id;
    state.adoptedExisting = session.adopted_existing;
    state.existingIdentity = session.existing_identity;
    state.hasCredentials = session.has_credentials;
    state.configDir = String(session.config_dir);
    state.busy = false;
    state.step = "cookie";
    render(ctx);
  } catch (e) {
    state.busy = false;
    state.error = e instanceof Error ? e.message : String(e);
    render(ctx);
  }
}

async function doCaptureCookie(ctx: WizardCtx): Promise<void> {
  const { state } = ctx;
  if (!state.sessionId) return;
  state.busy = true;
  state.cookieError = null;
  render(ctx);
  try {
    state.verifiedIdentity = await api.addAccountCaptureCookie(state.sessionId);
    state.cookieCaptured = true;
    state.busy = false;
    advanceAfterIdentity(ctx);
  } catch (e) {
    state.busy = false;
    state.cookieError = e instanceof Error ? e.message : String(e);
    render(ctx);
  }
}

/** After the browser step establishes the identity: skip the CLI step
 * entirely when the profile dir already holds credentials. */
function advanceAfterIdentity(ctx: WizardCtx): void {
  if (ctx.state.hasCredentials) {
    ctx.state.step = "finalize";
    seedFinalizeDefaults(ctx);
    render(ctx);
  } else {
    void gotoCliLogin(ctx);
  }
}

async function gotoCliLogin(ctx: WizardCtx): Promise<void> {
  const { state } = ctx;
  if (!state.sessionId) return;
  state.step = "login";
  state.loginFailure = null;
  try {
    state.terminalTitle = await api.addAccountStartCliLogin(state.sessionId);
  } catch (e) {
    state.loginFailure = { kind: "timeout", message: e instanceof Error ? e.message : String(e) };
    render(ctx);
    return;
  }
  startPolling(ctx);
}

function startPolling(ctx: WizardCtx): void {
  const { state } = ctx;
  state.loginStartedAt = Date.now();
  state.elapsedMs = 0;
  state.loginFailure = null;
  render(ctx);
  state.pollTimer = setInterval(() => void pollLogin(ctx), LOGIN_POLL_INTERVAL_MS);
  void pollLogin(ctx);
}

async function pollLogin(ctx: WizardCtx): Promise<void> {
  const { state } = ctx;
  if (!state.sessionId) return;
  state.elapsedMs = Date.now() - state.loginStartedAt;
  // No timeout while a route back to the browser login is on offer
  // (credentialsNoProfile) - timing out would replace the escape hatch with
  // a dead-end failure card.
  if (!state.credentialsNoProfile && isLoginTimedOut(state.elapsedMs)) {
    stopPolling(ctx);
    state.loginFailure = { kind: "timeout", message: "Timed out waiting for /login (5 min). Close and try again." };
    render(ctx);
    return;
  }
  try {
    const outcome = await api.addAccountCheckLogin(state.sessionId);
    const view = describeLoginOutcome(outcome);
    if (view.kind === "pending") {
      state.misdirected = view.misdirected;
      state.credentialsNoProfile = view.credentialsNoProfile;
      render(ctx);
      return;
    }
    stopPolling(ctx);
    if (view.kind === "ready") {
      state.verifiedIdentity = view.identity;
      state.step = "finalize";
      seedFinalizeDefaults(ctx);
      render(ctx);
    } else {
      state.loginFailure = { kind: view.kind, message: view.message };
      render(ctx);
    }
  } catch (e) {
    stopPolling(ctx);
    state.loginFailure = { kind: "timeout", message: e instanceof Error ? e.message : String(e) };
    render(ctx);
  }
}

function seedFinalizeDefaults(ctx: WizardCtx): void {
  const { state } = ctx;
  // The account name was already given on step 1 - no second name field on
  // finalize. prefillLabel(identity) only backstops the (unreachable in
  // practice) empty case.
  if (!state.label) state.label = state.nameInput.trim() || (state.verifiedIdentity ? prefillLabel(state.verifiedIdentity) : "");
  if (!state.icon) state.icon = pickAvailableIcon(ICON_POOL, ctx.usedIcons);
  if (!state.colour) state.colour = COLOUR_POOL[0]!;
}

async function doFinalize(ctx: WizardCtx): Promise<void> {
  const { state } = ctx;
  if (!state.sessionId) return;
  state.busy = true;
  state.error = null;
  render(ctx);
  try {
    const account = await api.addAccountFinalize(state.sessionId, state.label.trim(), state.colour, state.icon);
    close(ctx, account);
  } catch (e) {
    state.busy = false;
    state.error = e instanceof Error ? e.message : String(e);
    render(ctx);
  }
}

/**
 * Opens the add-account wizard. `existingAccounts` is used only to steer the
 * icon auto-pick away from icons already in use; resolves with the newly
 * created `Account` on success, or `null` if the user cancels/closes.
 */
export function openAddAccountWizard(existingAccounts: Account[]): Promise<Account | null> {
  const usedIcons = existingAccounts.map((a) => a.icon);

  return new Promise<Account | null>((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "aaw-overlay";

    const ctx: WizardCtx = {
      state: createInitialState(),
      overlay,
      usedIcons,
      resolve,
      onKey: () => {},
      disposeBack: () => {},
    };
    ctx.onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        requestClose(ctx);
      }
    };

    // Deliberately NO overlay-click dismiss: a stray click must never nuke a
    // half-done account setup. The X (and Escape) is the only way out, and it
    // confirms first past step 1. Phone hardware-back goes through the same
    // door: register with the back-button.ts overlay stack so back triggers
    // requestClose() too (same confirm-before-abandon rule past step 1).
    document.addEventListener("keydown", ctx.onKey);
    ctx.disposeBack = registerOverlayBack(() => {
      requestClose(ctx);
      return true;
    });

    document.body.appendChild(overlay);
    render(ctx);
  });
}
