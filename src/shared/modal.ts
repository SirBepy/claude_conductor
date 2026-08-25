import { html, render } from "lit-html";
import { registerOverlayBack } from "./back-button";
import "./modal.css";

// Shared host for the project -> location -> worktree -> new-session chain.
// One backdrop + one card slot; content morphs (shrink -> swap -> expand)
// between steps instead of tearing the host down, so the backdrop never
// flickers, even across the pickProject() -> openModelEffortModal() boundary.

const COLLAPSE_MS = 150; // must match modal.css's .modal-card-collapsing duration
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

// Bumped on every present/close call so a stale async continuation (a sleep
// or a debounced teardown) can no-op instead of stomping a newer call.
let hostGeneration = 0;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let backDisposer: (() => void) | null = null;
let focusGuardDisposer: (() => void) | null = null;

// What a shared-backdrop click (or hardware back) should do right now - see
// setBackdropCancel.
let backdropCancel: (() => void) | null = null;

export function ensureModalHost(): HTMLElement {
  let host = document.getElementById("modal-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "modal-host";
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.addEventListener("click", () => backdropCancel?.());
    const slot = document.createElement("div");
    slot.id = "modal-host-card-slot";
    host.append(backdrop, slot);
    document.body.appendChild(host);
  }
  return host;
}

/** Mount point each step renders into (never the host itself, a sibling of
 *  the backdrop). Root element needs the `modal-card` class for the morph CSS. */
export function modalCardSlot(): HTMLElement {
  return ensureModalHost().querySelector<HTMLElement>("#modal-host-card-slot")!;
}

/** Call at the start of every step-owning function, and again after a nested
 *  sub-picker resolves (to restore its own handler). */
export function setBackdropCancel(fn: (() => void) | null): void {
  backdropCancel = fn;
}

/** Blocks background keystrokes while a modal is open - the backdrop stops
 *  clicks by hit-testing, but focus is independent of that, so a still-
 *  focused textarea behind it keeps eating typed characters otherwise. */
function trapFocusInsideHost(host: HTMLElement): () => void {
  if (document.activeElement instanceof HTMLElement && !host.contains(document.activeElement)) {
    document.activeElement.blur();
  }
  const onFocusIn = (e: FocusEvent) => {
    const target = e.target;
    if (target instanceof HTMLElement && !host.contains(target)) target.blur();
  };
  document.addEventListener("focusin", onFocusIn);
  return () => document.removeEventListener("focusin", onFocusIn);
}

/** Renders a step's card via `renderFn`, morphing from whatever was showing
 *  (shrink -> swap -> expand), or fading in if nothing was. Safe right after
 *  an unrelated closeHostCard() - reuses its still-collapsing card as the
 *  morph's start point instead of re-collapsing, so the backdrop never drops. */
export async function presentHostCard(renderFn: () => void): Promise<void> {
  const myGen = ++hostGeneration;
  const host = ensureModalHost();
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }

  const slot = modalCardSlot();
  const prevCard = host.classList.contains("open")
    ? slot.querySelector<HTMLElement>(".modal-card")
    : null;
  if (prevCard && !prevCard.classList.contains("modal-card-morph-hidden")) {
    prevCard.classList.add("modal-card-collapsing", "modal-card-morph-hidden");
    await sleep(COLLAPSE_MS);
    if (myGen !== hostGeneration) return;
  }

  host.classList.add("open");
  if (!backDisposer) {
    backDisposer = registerOverlayBack(() => {
      backdropCancel?.();
      return true;
    });
    focusGuardDisposer = trapFocusInsideHost(host);
  }
  renderFn();
  if (myGen !== hostGeneration) return;

  const nextCard = slot.querySelector<HTMLElement>(".modal-card");
  if (nextCard) {
    nextCard.classList.add("modal-card-morph-hidden");
    await nextFrame();
    if (myGen !== hostGeneration) return;
    nextCard.classList.remove("modal-card-morph-hidden", "modal-card-collapsing");
  }
}

/** Closes the whole chain. Only the outermost function (pickProject(),
 *  openModelEffortModal) calls this - nested steps just resolve. Debounced
 *  by COLLAPSE_MS so a presentHostCard() arriving first cancels the teardown. */
export function closeHostCard(): void {
  const myGen = ++hostGeneration;
  const host = document.getElementById("modal-host");
  setBackdropCancel(null);
  if (!host) return;
  const card = modalCardSlot().querySelector<HTMLElement>(".modal-card");
  if (card) card.classList.add("modal-card-collapsing", "modal-card-morph-hidden");
  closeTimer = setTimeout(() => {
    if (myGen !== hostGeneration) return;
    host.classList.remove("open");
    render(html``, modalCardSlot());
    backDisposer?.();
    backDisposer = null;
    focusGuardDisposer?.();
    focusGuardDisposer = null;
    closeTimer = null;
  }, COLLAPSE_MS);
}
