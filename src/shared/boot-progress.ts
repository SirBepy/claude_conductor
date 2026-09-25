/**
 * Cold-boot progress overlay for the phone.
 *
 * Before this, `wireInitialFetches` held the first render until all three boot
 * fetches settled and nothing was painted in the meantime, so a slow cold start
 * over LTE was indistinguishable from a hang. This paints the wait instead: an
 * aggregate dial with a real percentage plus one line per fetch, so a single
 * slow leg is visibly the slow one.
 *
 * Remote-only. On desktop the same fetches go over the Tauri pipe, which
 * exposes no byte stream and is fast enough locally that an overlay would just
 * flash - `mountBootProgress` no-ops there.
 */

import "./boot-progress.css";
import { createLoadCopy, createLoadDial, paintLoadDial } from "./load-dial";
import { activeLoad, aggregateSnapshot } from "./load-progress";
import { isRemote } from "./transport";

/** The RPC methods `initBoot`'s gate actually waits on over the remote
 *  transport. `fetchTokens` is excluded deliberately: it short-circuits to `[]`
 *  on remote (see boot.ts's fetchTokenHistoryWithLive), so a leg for it would
 *  complete instantly and only add noise. */
const BOOT_METHODS = [
  { method: "get_settings", label: "Settings" },
  { method: "get_history", label: "Usage" },
] as const;

/** Grace period before the overlay appears. A warm boot settles well inside
 *  this, so the common fast path stays visually silent instead of flashing a
 *  dial for 80ms. */
const SHOW_AFTER_MS = 160;

export interface BootProgressHandle {
  /** Fade out and unmount. Idempotent. */
  done: () => void;
}

function legRow(label: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "boot-leg";
  row.dataset.state = "pending";
  row.innerHTML =
    '<i class="ph ph-circle-dashed"></i>' +
    `<span class="boot-leg-name"></span>` +
    '<span class="boot-leg-ms"></span>';
  const name = row.querySelector<HTMLElement>(".boot-leg-name");
  if (name) name.textContent = label;
  return row;
}

/**
 * Mount the overlay (after a short grace period) and start painting.
 * Returns a handle whose `done()` tears it down.
 */
export function mountBootProgress(): BootProgressHandle {
  if (!isRemote() || typeof document === "undefined") {
    return { done: () => {} };
  }

  let settled = false;
  let root: HTMLElement | null = null;
  let frame = 0;

  const showTimer = window.setTimeout(() => {
    if (settled) return;

    root = document.createElement("div");
    root.className = "boot-progress";
    root.setAttribute("role", "status");
    root.setAttribute("aria-live", "polite");

    const brand = document.createElement("div");
    brand.className = "boot-brand";
    brand.innerHTML = '<i class="ph ph-broadcast"></i>';
    brand.append(document.createTextNode("Claude Conductor"));

    const dial = createLoadDial();
    const copy = createLoadCopy("Connecting to your desktop");

    const legs = document.createElement("div");
    legs.className = "boot-legs";
    const rows = BOOT_METHODS.map(({ method, label }) => {
      const row = legRow(label);
      legs.append(row);
      return { method, row };
    });

    root.append(brand, dial, copy, legs);
    document.body.append(root);

    const tick = (): void => {
      if (settled) return;
      paintLoadDial(dial, aggregateSnapshot(BOOT_METHODS.map((b) => b.method)), copy);
      for (const { method, row } of rows) {
        const snap = activeLoad(method)?.snapshot() ?? null;
        const icon = row.querySelector<HTMLElement>("i");
        const ms = row.querySelector<HTMLElement>(".boot-leg-ms");
        if (!snap) {
          row.dataset.state = "pending";
          if (icon) icon.className = "ph ph-circle-dashed";
        } else if (snap.phase === "done") {
          row.dataset.state = "done";
          if (icon) icon.className = "ph ph-check-circle";
          if (ms && !ms.textContent) ms.textContent = `${(snap.elapsedMs / 1000).toFixed(1)}s`;
        } else {
          row.dataset.state = "running";
          if (icon) icon.className = "ph ph-circle-notch";
        }
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
  }, SHOW_AFTER_MS);

  return {
    done: () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(showTimer);
      if (frame) cancelAnimationFrame(frame);
      const el = root;
      if (!el) return;
      el.setAttribute("data-leaving", "");
      // Matches --motion-base; a stray overlay would swallow every tap, so the
      // removal is also armed on transitionend in case the timer is throttled
      // by a backgrounded tab.
      const remove = (): void => el.remove();
      el.addEventListener("transitionend", remove, { once: true });
      window.setTimeout(remove, 400);
    },
  };
}
