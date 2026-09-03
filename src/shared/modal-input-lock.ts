// Deliberately free of lit-html and modal.css: chat-click-handlers reaches
// this through pr-review-modal, and lit-html touches document at module eval,
// which breaks node-environment tests that never render a modal.

const lockedHosts: HTMLElement[] = [];
const keyAllowlists = new WeakMap<HTMLElement, (e: KeyboardEvent) => boolean>();
const selectableOptions = new WeakMap<HTMLElement, () => HTMLElement[]>();
let globalGuardDisposer: (() => void) | null = null;

function isInsideLockedHost(target: EventTarget | null): boolean {
  return target instanceof Node && lockedHosts.some((h) => h.contains(target));
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

/** Registers `host`'s ordered, number-selectable option elements - the trap
 *  below resolves `1`-`9` to the Nth and clicks it. The getter runs fresh on
 *  every keypress, so a re-rendered DOM needs no re-registration. Cleared
 *  when `host`'s lock is released. */
export function registerSelectableOptions(host: HTMLElement, getOptions: () => HTMLElement[]): void {
  selectableOptions.set(host, getOptions);
}

/** True while any modal (host-based or own-backdrop) holds the input lock -
 *  shortcuts.ts uses this to stop global shortcuts firing under a modal. */
export function isAnyModalOpen(): boolean {
  return lockedHosts.length > 0;
}

function ensureGlobalGuard(): void {
  if (globalGuardDisposer) return;
  // Focus half: the backdrop stops clicks by hit-testing, but focus is
  // independent of that, so a still-focused textarea behind it keeps eating
  // typed characters otherwise.
  const onFocusIn = (e: FocusEvent) => {
    const target = e.target;
    if (target instanceof HTMLElement && lockedHosts.length > 0 && !isInsideLockedHost(target)) {
      target.blur();
    }
  };
  // Keydown half, capture phase so it runs ahead of the default action and
  // other document dispatchers (global shortcuts). Escape, Enter and
  // `allowKey` matches skip stopPropagation so the modal's own handler still
  // sees them, but still get preventDefault so they can't also type into the
  // background.
  const onKeyDown = (e: KeyboardEvent) => {
    if (lockedHosts.length === 0) return;
    const inside = isInsideLockedHost(e.target);

    // Number-key select (todo 835): skipped while typing into the modal's
    // own text field so "2" still types a 2. Only the topmost (most
    // recently locked) host's registered options respond, matching which
    // step is actually mounted right now.
    if (/^[1-9]$/.test(e.key) && !(inside && isEditableTarget(e.target))) {
      const topHost = lockedHosts[lockedHosts.length - 1]!;
      const opt = selectableOptions.get(topHost)?.()[Number(e.key) - 1];
      if (opt) {
        e.preventDefault();
        if (!inside) e.stopPropagation();
        opt.click();
        return;
      }
    }

    if (inside) return;
    // A card that focuses nothing on open (the new-session dialog) leaves
    // focus on <body>, so its confirm/cancel keys arrive from outside the
    // host: swallowing them here killed Enter while Escape kept working.
    if (e.key === "Escape" || e.key === "Enter") return;
    const allowed = lockedHosts.some((h) => keyAllowlists.get(h)?.(e));
    if (allowed) {
      e.preventDefault();
      return;
    }
    e.stopPropagation();
    e.preventDefault();
  };
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("keydown", onKeyDown, true);
  globalGuardDisposer = () => {
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("keydown", onKeyDown, true);
  };
}

/** Locks background input to `host`: blurs whatever's focused outside it, and
 *  swallows keydowns whose target sits outside every locked host (own-
 *  backdrop modals call this directly; presentHostCard() calls it for
 *  #modal-host). `allowKey` exempts a key from stopPropagation only. */
export function lockInputToHost(host: HTMLElement, allowKey?: (e: KeyboardEvent) => boolean): () => void {
  ensureGlobalGuard();
  if (
    document.activeElement instanceof HTMLElement &&
    !host.contains(document.activeElement) &&
    !isInsideLockedHost(document.activeElement)
  ) {
    document.activeElement.blur();
  }
  lockedHosts.push(host);
  if (allowKey) keyAllowlists.set(host, allowKey);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const idx = lockedHosts.indexOf(host);
    if (idx !== -1) lockedHosts.splice(idx, 1);
    keyAllowlists.delete(host);
    selectableOptions.delete(host);
  };
}
