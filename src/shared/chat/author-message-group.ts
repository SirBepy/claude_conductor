// Folds a turn's authored (session-relayed) messages into one real .tool-chip
// on that turn's shared chip line, in the DOM shape createHandleToolChipClick
// already expects, so no second click listener is needed.
import type { RenderedMessage } from "./chat-transforms";
import { renderBlocks } from "./chat-transforms";
import { escapeHtml } from "../escape-html";
import { authorTagFor } from "./author-tag-source";
import { basename } from "../path-utils";
import { hydrateCharacterAvatars } from "../projects";
import { ensureMainStrip } from "./tool-strip";

const PALETTE_SIZE = 6;

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Deterministic class instead of raw hex, so the palette lives in CSS
// custom properties (chat-messages-user.css) rather than inline styles.
function colorClassFor(sessionId: string): string {
  return `author-color-${hashStr(sessionId) % PALETTE_SIZE}`;
}

function nameFor(sessionId: string): string {
  const { cwd } = authorTagFor(sessionId);
  return cwd ? basename(cwd) : "peer session";
}

function avatarHtml(sessionId: string, colorClass: string): string {
  const { charId } = authorTagFor(sessionId);
  const inner = charId
    ? `<img class="char-avatar" data-character-id="${escapeHtml(charId)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;image-rendering:pixelated">`
    : `<i class="ph ph-robot"></i>`;
  return `<span class="author-avatar ${colorClass}">${inner}</span>`;
}

/** Chip/bucket key for a turn's peer-message group - one per turn, so a run
 *  that streams in across several flushes keeps extending the same chip. */
const AUTHOR_KEY = "peer-msgs";

/** Marker key stashed on stripHost, gating the rebuild below - same idea as
 *  `rebuildCustomBucket`'s `data-tool-grouped` check, but keyed on the
 *  authored-message identity since this rebuild spans a range instead of a
 *  single element. */
const FOLD_MARKER_ATTR = "authoredFoldMarker";

/** Full rebuild each call that the authored-message set in range actually
 *  changed (same idempotence as the custom-view buckets), so a late-arriving
 *  peer message just grows the count - but an unrelated tool flush with no
 *  new/changed peer message is a no-op. */
export function foldAuthoredIntoStrip(
  messages: RenderedMessage[],
  messageEls: HTMLElement[],
  start: number,
  end: number,
  stripHost: HTMLElement,
): void {
  const run: RenderedMessage[] = [];
  for (let i = start; i < end; i++) {
    const m = messages[i];
    if (!m || !messageEls[i] || m.kind !== "user" || !m.authorSessionId) continue;
    run.push(m);
  }
  if (run.length === 0) return;

  const marker = run.map((m) => `${m.id ?? m.ts}:${m.authorSessionId}`).join("|");
  if (stripHost.dataset[FOLD_MARKER_ATTR] === marker) return;
  stripHost.dataset[FOLD_MARKER_ATTR] = marker;

  const { strip, panel } = ensureMainStrip(stripHost);
  let chip = strip.querySelector<HTMLButtonElement>(`:scope > .tool-chip[data-tool="${AUTHOR_KEY}"]`);
  if (!chip) {
    chip = document.createElement("button");
    chip.type = "button";
    chip.className = "tool-chip";
    chip.dataset.tool = AUTHOR_KEY;
    strip.appendChild(chip);
  }
  let bucket = panel.querySelector<HTMLElement>(`:scope > .tool-strip-group[data-tool="${AUTHOR_KEY}"]`);
  if (!bucket) {
    bucket = document.createElement("div");
    bucket.className = "tool-strip-group author-group-panel";
    bucket.dataset.tool = AUTHOR_KEY;
    bucket.hidden = true;
    panel.appendChild(bucket);
  }

  const seen: string[] = [];
  for (const m of run) {
    const id = m.authorSessionId!;
    if (!seen.includes(id)) seen.push(id);
  }
  const names = seen.map(nameFor);
  const label = names.length <= 2 ? names.join(" & ") : `${names[0]} +${names.length - 1}`;
  const count = run.length > 1 ? `<span class="tool-chip-count">×${run.length}</span>` : "";
  chip.innerHTML =
    `<span class="author-group-avatars">${seen.slice(0, 3).map((id) => avatarHtml(id, colorClassFor(id))).join("")}</span>` +
    `<span class="tool-chip-label">${escapeHtml(label)}</span>${count}`;

  bucket.innerHTML = run
    .map((m) => {
      const id = m.authorSessionId!;
      const colorClass = colorClassFor(id);
      return `<div class="author-group-row">${avatarHtml(id, colorClass)}` +
        `<div class="author-group-row-body"><div class="author-group-row-name ${colorClass}">${escapeHtml(nameFor(id))}</div>` +
        `<div class="author-group-row-text">${renderBlocks(m.content ?? [], true, true)}</div></div></div>`;
    })
    .join("");

  void hydrateCharacterAvatars(chip);
  void hydrateCharacterAvatars(bucket);
}
