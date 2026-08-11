// Scroll-position tracking + transcript reveal for ChatRenderer, split out of
// chat-dom-renderer.ts (ai_todo 598) so scroll concerns stay separate from the
// turn-fold/close DOM machinery.

import { highlightCodeBlocks, highlightInlineCode } from "./code-highlighter";
import type { ChatRenderer } from "./chat-renderer";

/** Distance (px) from the bottom within which we still treat the user as "at the bottom". */
export const SCROLL_BOTTOM_THRESHOLD = 64;

/** Element-level variant, for callers that have no ChatRenderer to hand. */
export function isElNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_BOTTOM_THRESHOLD;
}

/**
 * True when the scroll position is at (or within SCROLL_BOTTOM_THRESHOLD px of)
 * the bottom of the container, so a live update should keep following along.
 */
export function isNearBottom(r: ChatRenderer): boolean {
  return isElNearBottom(r.container);
}

export function scrollToBottom(r: ChatRenderer): void {
  r.container.scrollTop = r.container.scrollHeight;
}

/**
 * Hide the transcript instantly (no fade-out) so its build is invisible.
 * Paired with revealTranscript, which fades the finished frame back in.
 */
export function beginRevealHold(r: ChatRenderer): void {
  r.container.style.transition = "none";
  r.container.style.opacity = "0";
  // Start slightly below resting so the reveal settles UP into place.
  r.container.style.transform = "translateY(8px)";
}

/**
 * Fade + slide the assembled transcript in. Idempotent: a no-op once already
 * shown, so the settle reveal, the safety-timeout reveal, and the detach reset
 * can all call it freely.
 */
export function revealTranscript(r: ChatRenderer): void {
  if (r.container.style.opacity === "" || r.container.style.opacity === "1") return;
  // Commit the opacity:0 / offset paint before enabling the transition, else
  // the browser coalesces both into one frame and there is no animation.
  void r.container.offsetHeight;
  r.container.style.transition = "opacity 150ms ease, transform 180ms ease";
  r.container.style.opacity = "1";
  r.container.style.transform = "translateY(0)";
}

/**
 * Re-pin to the bottom after the bulk load's async content has grown the
 * transcript: await the code-highlight pass (it replaces each <pre> with a
 * taller shiki block), then scroll, then scroll once more on the next
 * macrotask to catch late attachment/image/font reflow. Initial-load pin, so
 * it does NOT gate on isNearBottom (async growth above the fold pushes the
 * bottom out of view, which would read as "scrolled up" and wrongly skip).
 */
export async function scrollToBottomWhenSettled(r: ChatRenderer, gen: number): Promise<void> {
  // Reveal no later than this even if shiki is slow on a huge code-heavy load,
  // so the transcript never stays blank for an awkward beat. The settle path
  // below reveals earlier (the common, fast case) and reveal is idempotent.
  const safety = setTimeout(() => {
    if (r._bulkGen === gen) revealTranscript(r);
  }, 220);
  try { await highlightCodeBlocks(r.container); } catch { /* ignore */ }
  highlightInlineCode(r.container);
  if (r._bulkGen !== gen || !r.sessionId) { clearTimeout(safety); return; }
  scrollToBottom(r);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  clearTimeout(safety);
  if (r._bulkGen !== gen || !r.sessionId) return;
  scrollToBottom(r);
  revealTranscript(r);
}
