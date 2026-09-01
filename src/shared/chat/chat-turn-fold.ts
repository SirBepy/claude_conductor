// Turn-fold + close-queue machinery for ChatRenderer, split out of
// chat-dom-renderer.ts (ai_todo 837) so that file keeps only DOM-node
// construction. Free functions taking the renderer `r` for the same reason
// as chat-dom-renderer.ts: dispatch and these renderers share instance state
// and TS has no partial classes.

import { RenderedMessage, isBoundaryMessage } from "./chat-transforms";
import { applyTurnCollapse } from "./tool-strip";
import { type TurnUsageTotals } from "./turn-chips";
import { turnProducedVisibleContent } from "./turn-visible-content";
import { finalizeStreamingBubble } from "./chat-dom-renderer";
import type { ChatRenderer } from "./chat-renderer";

/** Dataset key marking a row's footer, independent of DOM ancestry (todo 808). */
const FOOTER_KEY_ATTR = "foldedFooterKey";

/** The active turn's history-timestamp span (duration fallback), or 0. */
export function activeTurnTsSpan(r: ChatRenderer): number {
  if (r.activeTurnFirstTs <= 0 || r.activeTurnLastTs <= r.activeTurnFirstTs) return 0;
  const span = r.activeTurnLastTs - r.activeTurnFirstTs;
  // Distrust spans over 24h: mixed/garbage timestamps, hide the chip instead.
  return span <= 24 * 3600 * 1000 ? span : 0;
}

/**
 * Ensure the active turn's footer exists and is the LAST child of the
 * container, so it always sits below everything the turn has rendered.
 * Once the turn closes the footer stays pinned where it is (the next user
 * message renders after it). Live turns also get the ticking meta row;
 * bulk loads skip it (their rows settle from real totals at close).
 */
export function ensureActiveTurnFooter(r: ChatRenderer): void {
  if (r.activeTurnChipKey === null) return;
  const footer = r.turnFooters.getOrCreateFooter(r.activeTurnChipKey);
  if (footer !== r.container.lastElementChild) {
    r.container.appendChild(footer);
  }
  if (r.liveBuffer === null) {
    r.turnFooters.ensureLiveMetaRow(r.activeTurnChipKey, r.activeTurnStartedAtMs || Date.now());
    r.turnFooters.syncLiveTick(r.activeTurnChipKey);
    if (r.activeTurnStreamedText) {
      r.turnFooters.updateLiveTokenEstimate(r.activeTurnChipKey, r.activeTurnStreamedText);
    }
  }
}

/** True for a real user/compaction boundary OR an is_meta meta-turn row -
 *  both mint their own footer+chip key in handleChatEvent's normal path,
 *  so both end a "no turn open yet" leading segment. */
function opensOwnFooter(m: RenderedMessage): boolean {
  return isBoundaryMessage(m) || (m.kind === "system" && m.metaKind != null);
}

/**
 * Fold the loaded window's LEADING partial turn at initial load.
 *
 * `read_page` cuts the window by assistant-reply count, so it almost always
 * begins MID-turn: the rows before the first real boundary (the turn's
 * opening user message lives below the window) were rendered flat, because no
 * turn was open to group them when they streamed through bulkLoadEvents. That
 * left raw Read/Grep/... cards on screen until the user scrolled up far enough
 * for pagination to prepend the older batch and heal them.
 *
 * Run that same heal once here, at load: fold those leading rows into a chip
 * strip immediately. We have no usage for the turn (its turn_usage events
 * arrived before any turn was open and were dropped), so the meta row stays
 * absent until pagination brings the opening message - strictly better than
 * the flat cards shown before. No-op when the window already starts at a
 * boundary (no leading partial turn) or is empty. Stops at a meta-turn row
 * too (opensOwnFooter), not just a real boundary: unlike a genuine mid-turn
 * page cut, an is_meta row ALWAYS already has its own footer from the normal
 * per-event pass - re-folding it here would mint a duplicate one.
 */
export function foldLeadingPartialTurn(r: ChatRenderer): void {
  if (r.messages.length === 0) return;
  if (opensOwnFooter(r.messages[0]!)) return;
  let end = r.messages.length;
  for (let i = 0; i < r.messages.length; i++) {
    if (opensOwnFooter(r.messages[i]!)) { end = i; break; }
  }
  foldClosedRange(r, 0, end, null, 0);
}

/**
 * Fold a CLOSED turn range that arrived via pagination prepend (or heal the
 * window's leading partial turn once its opening user message arrives).
 * Reuses the turn's existing footer when some of its rows were folded
 * earlier (chunk straddling); otherwise creates one before the range's
 * closing boundary element and settles its meta row from the usage the
 * paginator accumulated out of the raw events.
 */
export function foldClosedRange(
  r: ChatRenderer,
  start: number,
  end: number,
  usage: TurnUsageTotals | null,
  tsSpanMs: number,
): void {
  if (end <= start) return;
  // An existing footer: rows folded earlier moved into it (tool rows) OR
  // carry the marker stamped below (authored rows never move, todo 808).
  let footer: HTMLElement | null = null;
  for (let i = start; i < end; i++) {
    const el = r.messageEls[i];
    if (!el) continue;
    const viaAncestry = el.closest<HTMLElement>(".turn-footer");
    if (viaAncestry) { footer = viaAncestry; break; }
    const markedKey = Number(el.dataset[FOOTER_KEY_ATTR]);
    if (el.dataset[FOOTER_KEY_ATTR] !== undefined && Number.isFinite(markedKey)) {
      footer = r.turnFooters.getOrCreateFooter(markedKey);
      break;
    }
  }
  const totals = usage
    ? { ...usage, durationMs: usage.durationMs > 0 ? usage.durationMs : tsSpanMs }
    : null;
  // A meta-classified row (peer/fleet/retry/wake) in range surfaces as the
  // inline chip, not the old centered marker (now CSS-hidden) - count
  // occurrences for a "×N" suffix, since pagination doesn't dedup consecutive
  // meta rows into one streak the way the live path's merge does.
  const metaRows = r.messages.slice(start, end).filter((m) => m.kind === "system" && m.metaKind);
  const metaRow = metaRows[0];
  let key: number | null = null;
  if (!footer) {
    // Skip the footer entirely for a turn with nothing to show (no usage,
    // no foldable tool rows, no meta chip) - an empty box helps nobody.
    const hasToolRows = r.messages
      .slice(start, end)
      .some((m) => m.kind === "tool_use" || m.kind === "tool_result"
        || (m.kind === "user" && !!m.authorSessionId));
    if (!totals && !hasToolRows && !metaRow) {
      applyTurnCollapse(r.messages, r.messageEls, start, end, null);
      return;
    }
    key = ++r._chipKeySeq;
    footer = r.turnFooters.getOrCreateFooter(key);
    const anchor = r.messageEls[end] ?? null;
    if (anchor && anchor.parentElement === r.container) {
      r.container.insertBefore(footer, anchor);
    } else {
      const last = r.messageEls[end - 1];
      if (last && last.parentElement === r.container) last.after(footer);
      else r.container.appendChild(footer);
    }
    if (totals) r.turnFooters.settleMetaRow(key, totals);
  } else {
    const existingKey = Number(footer.dataset.turnId);
    key = Number.isFinite(existingKey) ? existingKey : null;
    if (totals && key !== null && !footer.querySelector(".turn-meta-chips")) {
      r.turnFooters.settleMetaRow(key, totals);
    }
  }
  if (metaRow?.metaKind && key !== null) {
    r.turnFooters.ensureMetaChip(key, {
      kind: metaRow.metaKind,
      label: metaRow.text ?? "",
      detail: metaRow.metaDetail ?? "",
      streakCount: metaRows.length,
    });
  }
  // Marks rows that never physically moved (authored) for the lookup above.
  if (key !== null) {
    for (let i = start; i < end; i++) {
      const el = r.messageEls[i];
      if (el) el.dataset[FOOTER_KEY_ATTR] = String(key);
    }
  }
  applyTurnCollapse(r.messages, r.messageEls, start, end, footer);
}

/** Combined totals for two turns rendered as one footer. Input is the LATEST
 *  turn's (it's context size, not a per-turn cost), everything else adds. */
function sumTurnTotals(a: TurnUsageTotals, b: TurnUsageTotals): TurnUsageTotals {
  return {
    durationMs: a.durationMs + b.durationMs,
    outputTokens: a.outputTokens + b.outputTokens,
    inputTokens: Math.max(a.inputTokens, b.inputTokens),
    cacheCreate: a.cacheCreate + b.cacheCreate,
    cacheRead: a.cacheRead + b.cacheRead,
    costUsd: a.costUsd + b.costUsd,
    awaiting: b.awaiting ?? a.awaiting,
  };
}

/** `allowMetaMerge: false` for a close that only SPLITS a turn (the AUQ card):
 *  its visible row lands AFTER this call, so the merge test below misreads it. */
export function enqueueTurnClose(r: ChatRenderer, opts?: { allowMetaMerge?: boolean }): void {
  finalizeStreamingBubble(r);
  // The next turn folds into fresh groups; closed-turn rows already carry
  // data-tool-grouped, so processTurnCloseQueue won't re-fold them.
  clearRunningHighlight(r);
  r.activeToolGroups.clear();
  // Drop any id left outstanding by an interrupted/never-resulted tool call,
  // else it permanently blocks the next turn's activity label from clearing.
  r.outstandingActivityToolIds.clear();
  if (r.activeTurnChipKey !== null) {
    const turnStart = r.activeTurnStart ?? r.messages.length;
    // Trim trailing noise-tail messages (e.g. "Request interrupted by user")
    // from the turn range so the chips footer lands BEFORE them, keeping the
    // visual order: chips → divider label → next user message.
    let end = r.messages.length;
    while (end > turnStart && r.messages[end - 1]?.noiseLabel) end--;
    // A wake turn that never spoke has no bubble, so its footer would stack
    // under the previous turn's as a detached block of chips and screenshots.
    const mergeIntoKey = opts?.allowMetaMerge !== false
      && r.activeTurnIsMeta
      && r.prevTurnChipKey !== null
      && !turnProducedVisibleContent(r)
      ? r.prevTurnChipKey
      : null;
    r.closeTurnQueue.push({
      start: turnStart,
      end,
      chipKey: r.activeTurnChipKey,
      usage: r.activeTurnUsage,
      tsSpanMs: activeTurnTsSpan(r),
      mergeIntoKey,
    });
    r.prevTurnChipKey = mergeIntoKey ?? r.activeTurnChipKey;
  }
  r.resetActiveTurnMeta();
  r.activeTurnStart = null;
}

/**
 * Drop the "currently working" pulse from a turn's chips and forget its
 * in-flight calls. Called when the turn closes (the next user message) so a
 * tool that never reported a result can't leave its chip pulsing forever.
 */
export function clearRunningHighlight(r: ChatRenderer): void {
  if (r.activeTurnChipKey !== null) {
    const footer = r.turnFooters.getOrCreateFooter(r.activeTurnChipKey);
    footer.querySelectorAll<HTMLElement>(".tool-chip--running")
      .forEach((c) => c.classList.remove("tool-chip--running"));
  }
  r.activityToolCanon = null;
}

/**
 * Pulse the SINGLE main-strip chip for the AI's current activity (the tool the
 * `lastActivity` line describes, e.g. "Editing api.ts" -> the File-Changes
 * chip). Only that chip pulses - NOT every tool with an in-flight call, which
 * lit up the whole strip during parallel calls / subagent turns. Live only:
 * bulk replay nets every result and the transcript is hidden until it settles,
 * so a pulse there would be both invisible and misleading.
 */
export function applyRunningHighlight(r: ChatRenderer): void {
  if (r.liveBuffer !== null || r.activeTurnChipKey === null) return;
  const footer = r.turnFooters.getOrCreateFooter(r.activeTurnChipKey);
  // The main strip is a direct child of the footer (subagent strips live
  // deeper inside buckets - we only pulse top-level chips). Walk children
  // directly rather than rely on :scope, which jsdom handles inconsistently.
  const strip = [...footer.children].find(
    (c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains("tool-strip"),
  );
  if (!strip) return;
  const topChips = [...strip.children].filter(
    (c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains("tool-chip"),
  );
  for (const node of topChips) {
    const tool = node.dataset.tool;
    const running = !!tool && tool === r.activityToolCanon;
    node.classList.toggle("tool-chip--running", running);
  }
}

export function processTurnCloseQueue(r: ChatRenderer): void {
  if (r.closeTurnQueue.length === 0) return;
  for (const { start, end, chipKey, usage, tsSpanMs, mergeIntoKey } of r.closeTurnQueue) {
    let footer: HTMLElement | null = null;
    // History turns have no duration_ms; fall back to the ts span. Resolved
    // once here, so an absorbed turn contributes the same corrected duration
    // to its host's row that it would have displayed on its own.
    const settled = usage
      ? { ...usage, durationMs: usage.durationMs > 0 ? usage.durationMs : tsSpanMs }
      : null;
    if (chipKey !== null) {
      footer = r.turnFooters.getOrCreateFooter(chipKey);
      // Pin the footer at the turn's bottom: right before the next turn's
      // first element (always a direct container child), else at the end.
      const anchor = r.messageEls[end] ?? null;
      if (anchor && anchor.parentElement === r.container) {
        r.container.insertBefore(footer, anchor);
      } else if (footer.parentElement !== r.container) {
        r.container.appendChild(footer);
      }
      if (settled) {
        r.turnFooters.settleMetaRow(chipKey, settled);
      } else {
        // No usage ever arrived (interrupted live turn): freeze the live
        // row at its last elapsed/estimate. No-op when no row exists.
        r.turnFooters.cancelMetaRow(chipKey);
      }
    }
    applyTurnCollapse(r.messages, r.messageEls, start, end, footer);
    // After the collapse, so every chip/screenshot this turn produced exists
    // before it moves house.
    if (chipKey !== null && mergeIntoKey !== null) {
      const destTotals = r.turnFooters.getTotals(mergeIntoKey);
      if (r.turnFooters.absorbInto(chipKey, mergeIntoKey) && settled) {
        r.turnFooters.settleMetaRow(mergeIntoKey, destTotals ? sumTurnTotals(destTotals, settled) : settled);
      }
    }
  }
  r.closeTurnQueue = [];
}
