// Diagnostic for the 2026-11-04 field report: a chat pane showed no input, a
// blank-padded transcript, and its header and the right rail sat ~150px too
// high (a clipped ancestor had scrolled). It could not be reproduced, and the
// DOM state is gone by the time anyone looks, so this samples the pane while
// the view is mounted and writes one app-log line when the chrome is broken.

import { visibleInterval } from "../../shared/visible-interval";
import { reportWebviewDiag } from "../../shared/perf";
import { getSelectedSessionId } from "./permission-modal";

const SAMPLE_MS = 2000;

export interface ChromeSnapshot {
  /** A `.session-composer` exists in the pane (a pane with none is a dashboard or empty state). */
  hasComposer: boolean;
  composerInputVisible: boolean;
  composerInputBottom: number;
  viewportHeight: number;
  /** A question/permission card or its collapsed bar is mounted. */
  cardMounted: boolean;
  /** Ancestors of the pane (and the pane) scrolled away from 0, as "tag.class top=N". */
  scrolledAncestors: string[];
  transcriptPaddingBottom: number;
}

/** Why the chrome counts as broken, or null when it is fine. A card legitimately
 *  hides the composer, so a hidden input only counts with no card mounted. */
export function brokenChromeReason(s: ChromeSnapshot): string | null {
  const reasons: string[] = [];
  if (s.scrolledAncestors.length) reasons.push("ancestor scrolled");
  if (s.hasComposer && !s.cardMounted) {
    if (!s.composerInputVisible) reasons.push("composer hidden with no card");
    else if (s.composerInputBottom > s.viewportHeight + 1) reasons.push("composer below the viewport");
  }
  return reasons.length ? reasons.join(", ") : null;
}

function snapshot(view: HTMLElement, pane: HTMLElement): ChromeSnapshot {
  const scrolled: string[] = [];
  for (let el: HTMLElement | null = pane; el && el !== document.documentElement; el = el.parentElement) {
    if (el.scrollTop !== 0 || el.scrollLeft !== 0) {
      scrolled.push(`${el.tagName.toLowerCase()}.${el.className} top=${Math.round(el.scrollTop)}`);
    }
  }
  const composer = pane.querySelector<HTMLElement>(".session-composer");
  const input = pane.querySelector<HTMLElement>(".composer-textarea:not(#prompt-card-host *)");
  const inputRect = input?.getBoundingClientRect();
  const msgs = pane.querySelector<HTMLElement>(".session-messages");
  return {
    // getClientRects is empty for a pane hidden by display:none (another view on top), where a zero-height input is expected.
    hasComposer: !!composer && view.isConnected && pane.getClientRects().length > 0,
    composerInputVisible: !!input && !!inputRect && inputRect.height > 0 && getComputedStyle(input).visibility !== "hidden",
    composerInputBottom: inputRect?.bottom ?? 0,
    viewportHeight: window.innerHeight,
    cardMounted: !!pane.querySelector(".prompt-card, .prompt-collapsed"),
    scrolledAncestors: scrolled,
    transcriptPaddingBottom: msgs ? parseFloat(getComputedStyle(msgs).paddingBottom) || 0 : 0,
  };
}

/** Samples every SAMPLE_MS while visible and logs when the broken state first
 *  appears or its reason changes, never once per sample. Returns the disposer. */
export function startChromeWatchdog(view: HTMLElement, pane: HTMLElement): () => void {
  let lastReason: string | null = null;
  return visibleInterval(() => {
    const snap = snapshot(view, pane);
    const reason = brokenChromeReason(snap);
    if (reason === lastReason) return;
    lastReason = reason;
    if (!reason) {
      reportWebviewDiag("[chrome] pane chrome recovered");
      return;
    }
    const sid = getSelectedSessionId() ?? "-";
    const paneRect = pane.getBoundingClientRect();
    reportWebviewDiag(
      `[chrome] BROKEN: ${reason} | session=${sid} viewport=${window.innerWidth}x${snap.viewportHeight}`
      + ` pane=${Math.round(paneRect.top)}..${Math.round(paneRect.bottom)} input=${snap.composerInputVisible ? "visible" : "hidden"}@${Math.round(snap.composerInputBottom)}`
      + ` card=${snap.cardMounted} transcriptPadBottom=${Math.round(snap.transcriptPaddingBottom)}`
      + ` scrolled=[${snap.scrolledAncestors.join("; ")}]`,
    );
  }, SAMPLE_MS);
}
