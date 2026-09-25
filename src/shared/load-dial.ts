/**
 * The determinate loading dial: DOM for a `LoadSnapshot`, plus the frame loop
 * that polls a tracker and keeps it painted.
 *
 * Split from load-progress.ts so the progress math stays unit-testable without
 * a DOM, and shared by the cold-boot overlay and the chat transcript overlay so
 * the two surfaces cannot drift apart visually.
 */

import "./load-dial.css";
import type { LoadSnapshot } from "./load-progress";

/** Circumference of the r=30 arc; see the stroke-dasharray in load-dial.css. */
const CIRCUMFERENCE = 188.5;

export function createLoadDial(): HTMLElement {
  const el = document.createElement("div");
  el.className = "load-dial";
  el.setAttribute("data-indeterminate", "");
  el.innerHTML =
    '<svg viewBox="0 0 68 68" aria-hidden="true">' +
    '<circle class="load-dial-track" cx="34" cy="34" r="30"></circle>' +
    '<circle class="load-dial-arc" cx="34" cy="34" r="30"></circle>' +
    "</svg>" +
    '<div class="load-dial-pct"><span class="load-dial-num">0</span><small>%</small></div>';
  return el;
}

/** Copy block (`what` + live ETA) that sits under a dial. */
export function createLoadCopy(what: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "load-copy";
  const whatEl = document.createElement("div");
  whatEl.className = "load-what";
  whatEl.textContent = what;
  const etaEl = document.createElement("div");
  etaEl.className = "load-eta";
  el.append(whatEl, etaEl);
  return el;
}

/** Human ETA for a snapshot. Returns the elapsed-plus-reason form once the
 *  estimate has been abandoned, so the copy never counts down past zero. */
export function etaLabel(snap: LoadSnapshot): string {
  if (snap.phase === "done") return "";
  if (snap.phase === "overdue" || snap.etaMs === null) {
    return `${Math.round(snap.elapsedMs / 1000)}s · longer than usual`;
  }
  const seconds = snap.etaMs / 1000;
  const left = seconds < 0.15 ? "almost there" : `~${seconds.toFixed(1)}s left`;
  if (snap.totalBytes !== null && snap.receivedBytes > 0) {
    const kb = Math.round(snap.receivedBytes / 1024);
    const totalKb = Math.round(snap.totalBytes / 1024);
    return `${left} · ${kb} of ${totalKb} KB`;
  }
  return left;
}

/** Paint one snapshot onto a dial (and optionally its copy block). */
export function paintLoadDial(dial: HTMLElement, snap: LoadSnapshot, copy?: HTMLElement): void {
  dial.setAttribute("data-phase", snap.phase);
  if (snap.fraction === null) {
    dial.setAttribute("data-indeterminate", "");
  } else {
    dial.removeAttribute("data-indeterminate");
    const arc = dial.querySelector<SVGCircleElement>(".load-dial-arc");
    const num = dial.querySelector<HTMLElement>(".load-dial-num");
    if (arc) arc.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - snap.fraction));
    if (num) num.textContent = String(Math.round(snap.fraction * 100));
  }
  const etaEl = copy?.querySelector<HTMLElement>(".load-eta");
  if (etaEl) {
    etaEl.textContent = etaLabel(snap);
    if (snap.phase === "overdue") etaEl.setAttribute("data-overdue", "");
    else etaEl.removeAttribute("data-overdue");
  }
}

/**
 * Repaint `dial` every frame from whatever `source` returns, until `source`
 * reports `done` or the returned stop function is called.
 *
 * `source` is a function rather than a tracker because the load being watched
 * often does not exist yet at mount time: the chat overlay is put up before
 * `load_history_page` is dispatched, and boot watches several trackers at once.
 * Resolving per frame lets the dial start indeterminate and pick up the real
 * numbers the moment they appear.
 *
 * Returns the stopper rather than self-cancelling on `done` alone so a caller
 * that unmounts mid-load (the user backs out of a chat) always has a way to
 * kill the loop - an rAF chain with no handle is how these leak.
 */
export function driveLoadDial(
  dial: HTMLElement,
  source: () => LoadSnapshot,
  copy?: HTMLElement,
): () => void {
  let frame = 0;
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    const snap = source();
    paintLoadDial(dial, snap, copy);
    if (snap.phase === "done") return;
    frame = requestAnimationFrame(tick);
  };
  tick();
  return () => {
    stopped = true;
    if (frame) cancelAnimationFrame(frame);
  };
}
