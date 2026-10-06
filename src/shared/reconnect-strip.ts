/**
 * Slim status strip at the top of the phone app, shown while the link to the
 * PC is down or a load is taking long enough to look like a hang. Reads
 * connection-state.ts; remote-only, so desktop never mounts it.
 */

import "./reconnect-strip.css";
import { linkSnapshot, type LinkSnapshot } from "./connection-state";
import { etaLabel } from "./load-dial";
import { isRemote } from "./transport";
import { visibleInterval } from "./visible-interval";

const TICK_MS = 500;

/** A WS that drops and reopens within this window never shows the strip, so
 *  routine reconnects do not flicker it. */
const SHOW_AFTER_MS = 800;

/** Surfaces that already paint the same load with the full dial. */
const DIAL_OVERLAYS = ".chat-loading-overlay, .boot-progress";

export interface StripView {
  icon: string;
  text: string;
}

/** What the strip says for a snapshot, or null to hide it. */
export function stripView(snap: LinkSnapshot, dialOnScreen: boolean): StripView | null {
  if (snap.kind === "ok") return null;
  const secs = Math.round(snap.elapsedMs / 1000);
  if (snap.kind === "reconnecting") {
    return { icon: "ph-wifi-slash", text: `Reconnecting to your PC… ${secs}s` };
  }
  if (dialOnScreen) return null;
  // Only a Content-Length makes the percentage measured rather than guessed.
  if (snap.load.phase === "streaming" && snap.load.fraction !== null && snap.load.totalBytes !== null) {
    return { icon: "ph-download-simple", text: `Loading ${Math.round(snap.load.fraction * 100)}% · ${etaLabel(snap.load)}` };
  }
  return { icon: "ph-hourglass-medium", text: `Waiting for your PC… ${secs}s` };
}

export function mountReconnectStrip(): () => void {
  if (!isRemote() || typeof document === "undefined") return () => {};

  const el = document.createElement("div");
  el.className = "reconnect-strip";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.hidden = true;
  const icon = document.createElement("i");
  const text = document.createElement("span");
  el.append(icon, text);
  document.body.prepend(el);

  let notOkSince: number | null = null;
  const tick = (): void => {
    const now = Date.now();
    const view = stripView(linkSnapshot(now), !!document.querySelector(DIAL_OVERLAYS));
    if (!view) {
      notOkSince = null;
      el.hidden = true;
      return;
    }
    notOkSince ??= now;
    if (now - notOkSince < SHOW_AFTER_MS) return;
    icon.className = `ph ${view.icon}`;
    text.textContent = view.text;
    el.hidden = false;
  };
  const stop = visibleInterval(tick, TICK_MS);
  return () => {
    stop();
    el.remove();
  };
}
