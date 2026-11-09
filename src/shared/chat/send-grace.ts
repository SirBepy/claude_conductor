// Grace window for sends and card answers: the action waits a few seconds
// behind an "Undo" bar instead of reaching claude at once. claude starts
// answering the moment it receives a message, so the only way to take one
// back is to not have sent it yet. One pending action per key (a chat id);
// a newer action on the same key fires the older one first, so order holds.
import "./send-grace.css";

export const SEND_GRACE_MS = 3000;

/** Test seam: view specs set `window.__ccSendGraceMs = 0` (vitest, `globalThis`) so a send reaches the
 *  mocked backend at once, and the grace spec sets it back to a real value. */
export function graceMs(): number {
  const override = (globalThis as unknown as { __ccSendGraceMs?: unknown }).__ccSendGraceMs;
  return typeof override === "number" && override >= 0 ? override : SEND_GRACE_MS;
}

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  fire: () => Promise<void> | void;
  onUndo: () => void;
  bar: HTMLElement;
}

const pending = new Map<string, Pending>();
let flushOnLeave = false;

export interface GraceOpts {
  key: string;
  /** What is being held, shown in the bar. */
  label: string;
  /** Where the bar goes; the composer's slot, or {@link floatingGraceMount}. */
  mount: HTMLElement;
  /** Runs once the window lapses (or earlier, when flushed). */
  fire: () => Promise<void> | void;
  /** Runs on Undo, to put the draft back. */
  onUndo: () => void;
}

/** Hold `fire` for the grace window. With a zero window it runs now and the
 *  returned promise follows it; otherwise it resolves at once. */
export function startGrace(o: GraceOpts): Promise<void> {
  flushGrace(o.key);
  const ms = graceMs();
  if (ms <= 0) return Promise.resolve(o.fire());
  if (!flushOnLeave && typeof window !== "undefined") {
    flushOnLeave = true;
    // A window closing inside the grace period must not eat the message.
    window.addEventListener("pagehide", () => flushAllGrace());
  }
  const bar = buildBar(o.label, ms, () => undoGrace(o.key));
  o.mount.appendChild(bar);
  const timer = setTimeout(() => flushGrace(o.key), ms);
  pending.set(o.key, { timer, fire: o.fire, onUndo: o.onUndo, bar });
  return Promise.resolve();
}

function buildBar(label: string, ms: number, onUndo: () => void): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "send-grace-bar";
  bar.setAttribute("role", "status");
  bar.style.setProperty("--send-grace-ms", `${ms}ms`);
  bar.innerHTML =
    `<i class="ph ph-paper-plane-tilt send-grace-icon"></i>` +
    `<span class="send-grace-label"></span>` +
    `<button type="button" class="send-grace-undo"><i class="ph ph-arrow-u-up-left"></i>Undo</button>` +
    `<span class="send-grace-fuse" aria-hidden="true"></span>`;
  const text = bar.querySelector<HTMLElement>(".send-grace-label");
  if (text) text.textContent = label;
  bar.querySelector<HTMLButtonElement>(".send-grace-undo")?.addEventListener("click", onUndo);
  return bar;
}

/** A short single-line preview of what is being held. */
export function graceLabel(prefix: string, text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const clipped = flat.length > 48 ? `${flat.slice(0, 47)}…` : flat;
  return clipped ? `${prefix}: ${clipped}` : prefix;
}

/** Fire the pending action for `key` now, if any. */
export function flushGrace(key: string): void {
  const p = pending.get(key);
  if (!p) return;
  pending.delete(key);
  clearTimeout(p.timer);
  p.bar.remove();
  void Promise.resolve(p.fire());
}

export function flushAllGrace(): void {
  for (const key of [...pending.keys()]) flushGrace(key);
}

/** Cancel the pending action for `key` and hand its content back. */
export function undoGrace(key: string): boolean {
  const p = pending.get(key);
  if (!p) return false;
  pending.delete(key);
  clearTimeout(p.timer);
  p.bar.remove();
  p.onUndo();
  return true;
}

export function hasGrace(key: string): boolean {
  return pending.has(key);
}

/** Move a still-pending bar into a freshly rendered mount (the composer
 *  rebuilds its DOM on a session switch and would otherwise drop the bar). */
export function remountGraceBar(key: string, mount: HTMLElement): void {
  const p = pending.get(key);
  if (p) mount.appendChild(p.bar);
}

/** Detach a bar from its mount without touching the pending action, so
 *  leaving a chat never leaves its undo bar floating over another. */
export function detachGraceBar(key: string): void {
  pending.get(key)?.bar.remove();
}

/** Fixed bottom-centre host for answers, whose card is already gone. */
export function floatingGraceMount(): HTMLElement {
  let host = document.querySelector<HTMLElement>(".send-grace-floating");
  if (!host) {
    host = document.createElement("div");
    host.className = "send-grace-floating";
    document.body.appendChild(host);
  }
  return host;
}
