export const LS_ANIM = "cc_sidebar_animations";

export function loadAnimEnabled(): boolean {
  try { return localStorage.getItem(LS_ANIM) !== "off"; } catch { return true; }
}

function keyOf(li: HTMLLIElement): string {
  // Explicit key for keyed non-session rows (empty/setting-up/stalled).
  // Without it these rows have no identity: the reconciler can't match,
  // exit, or replace them, so every re-render appends a fresh copy and the
  // stale ones pile up ("two Setting up... rows plus No active sessions").
  if (li.dataset.rowKey) return li.dataset.rowKey;
  if (li.dataset.sessionId) return `s:${li.dataset.sessionId}`;
  if (li.dataset.placeholderId) return `p:${li.dataset.placeholderId}`;
  if (li.classList.contains("pending")) return "pending";
  return "";
}

// Keys already committed to exiting — filtered out of entries on every reconcile.
const exitingKeys = new Set<string>();

// The subset of exitingKeys whose exit was USER-INITIATED (click-close via
// markSessionExiting). These stay suppressed while the backend still lists
// the session (state changes before the session truly ends) and clear only
// once it is absent from entries. Exits started by the reconciler itself
// (key dropped from entries) are NOT sticky: if the key returns, the row
// must revive - a transient empty refresh once suppressed every session
// forever, leaving only unclickable pinned .row-exiting copies on screen.
const stickyExitKeys = new Set<string>();

// Per-node safety-removal timers. An exiting row is normally removed on its own
// `animationend`. Because the row is taken OUT of layout flow the instant it
// starts exiting (see beginExit), removing it can no longer reflow its
// siblings, so `animationend` removal is safe — there is no flash-back to
// guard against. This timer is only a fallback for when no `animationend`
// fires (animations disabled mid-flight, detached node, etc.).
const exitTimers = new Map<HTMLLIElement, ReturnType<typeof setTimeout>>();

const EXIT_SAFETY_MS = 1500; // > slideOutLeft (0.28s); fallback remover only.

function removeExitNode(li: HTMLLIElement): void {
  const t = exitTimers.get(li);
  if (t !== undefined) { clearTimeout(t); exitTimers.delete(li); }
  if (li.parentElement) li.remove();
}

// Clear any in-progress FLIP styles (transform/transition/zIndex set by
// flipNodes). Safe to call before measuring layout: transforms are purely
// visual and don't affect offsetTop, but DO affect getBoundingClientRect.
function clearFlipState(li: HTMLLIElement): void {
  li.style.transition = "none";
  li.style.transform = "";
  li.style.boxShadow = "";
  li.style.zIndex = "";
}

// Apply absolute pin at explicitly provided geometry. Callers must read
// geometry in a batch BEFORE calling this, because setting position:absolute
// reflowed siblings change their offsetTop for subsequent reads.
function applyPin(li: HTMLLIElement, top: number, left: number, width: number, height: number): void {
  li.style.position = "absolute";
  li.style.boxSizing = "border-box";
  li.style.top = `${top}px`;
  li.style.left = `${left}px`;
  li.style.width = `${width}px`;
  li.style.height = `${height}px`;
  li.style.margin = "0";
}

// Pin a row at pre-captured geometry and start its slide-out animation.
// Does NOT animate the survivors — the caller owns that.
function beginExitAt(li: HTMLLIElement, top: number, left: number, width: number, height: number): void {
  if (li.classList.contains("row-exiting")) return;
  applyPin(li, top, left, width, height);
  li.classList.add("row-exiting");
  const remove = () => removeExitNode(li);
  li.addEventListener("animationend", remove, { once: true });
  exitTimers.set(li, setTimeout(remove, EXIT_SAFETY_MS));
}

// Start a row's exit: clear FLIP state, read geometry, pin and slide out.
// Safe for single-row exits (markSessionExiting). For multi-row exits use
// the batch-capture pattern in reconcileList to avoid reflow corruption.
function beginExit(li: HTMLLIElement): void {
  // Read any active FLIP translateY before clearing it. offsetTop reflects the
  // post-reflow layout position, but the transform visually offsets the row.
  // Pin at the visual position so this row doesn't land on top of another
  // already-exiting row that occupies the same layout slot.
  const m = getComputedStyle(li).transform;
  const flipDy = m && m !== "none" ? new DOMMatrix(m).m42 : 0;
  clearFlipState(li);
  beginExitAt(li, li.offsetTop + flipDy, li.offsetLeft, li.offsetWidth, li.offsetHeight);
}

function updateNode(kept: HTMLLIElement, html: string): void {
  const tmp = document.createElement("ul");
  tmp.innerHTML = html;
  const fresh = tmp.firstElementChild as HTMLLIElement | null;
  if (!fresh) return;
  kept.className = fresh.className;
  kept.innerHTML = fresh.innerHTML;
  for (const attr of fresh.attributes) {
    if (attr.name !== "class") kept.setAttribute(attr.name, attr.value);
  }
}

function parseHtml(html: string): HTMLLIElement | null {
  const tmp = document.createElement("ul");
  tmp.innerHTML = html;
  return tmp.firstElementChild as HTMLLIElement | null;
}

function flipNodes(nodes: HTMLLIElement[], beforeRects: Map<string, DOMRect>): void {
  requestAnimationFrame(() => {
    // Measure pass: classify each move and find the bottom-most RISING row.
    // Only that row casts the lift shadow — otherwise every rising row drops
    // its own shadow onto the row beneath it, so a group moving up stacks a
    // pile of shadows on the bottom element. One shadow, under the whole group.
    const moves: Array<{ node: HTMLLIElement; dy: number; rising: boolean }> = [];
    let bottomRiser: HTMLLIElement | null = null;
    let bottomRiserTop = -Infinity;
    for (const node of nodes) {
      const k = keyOf(node);
      if (!beforeRects.has(k)) continue;
      const top = node.getBoundingClientRect().top;
      const dy = beforeRects.get(k)!.top - top;
      if (Math.abs(dy) < 0.5) continue;
      const rising = dy > 20;
      moves.push({ node, dy, rising });
      if (rising && top > bottomRiserTop) { bottomRiserTop = top; bottomRiser = node; }
    }

    // Invert: jump each row to its old position with no transition.
    for (const { node, dy } of moves) {
      node.style.transition = "none";
      node.style.transform = `translateY(${dy}px)`;
    }

    // Play: animate every row to its final spot next frame.
    requestAnimationFrame(() => {
      for (const { node, rising } of moves) {
        if (rising) {
          node.style.zIndex = "10";
          if (node === bottomRiser) node.style.boxShadow = "0 6px 22px rgba(0,0,0,0.55)";
          node.style.transition = "transform 0.34s cubic-bezier(0.34,1.2,0.64,1), box-shadow 0.34s";
          node.style.transform = "translateY(0) scale(1.036)";
          setTimeout(() => {
            node.style.transition = "transform 0.15s ease-out, box-shadow 0.15s";
            node.style.transform = "";
            node.style.boxShadow = "";
            node.addEventListener("transitionend", () => {
              node.style.zIndex = "";
              node.style.transition = "";
            }, { once: true });
          }, 340);
        } else {
          node.style.transition = "transform 0.3s cubic-bezier(0.34,1.2,0.64,1)";
          node.style.transform = "";
          node.addEventListener("transitionend", () => { node.style.transition = ""; }, { once: true });
        }
      }
    });
  });
}

/**
 * Immediately start the exit animation for a session row at click-time, before
 * the backend round-trip fires instances-changed. Pins the row out of flow and
 * slides the survivors up right away (more responsive than waiting for the
 * reconcile). The follow-up reconcile finds the survivors already at their
 * final positions, so its own FLIP no-ops them.
 */
export function markSessionExiting(listEl: HTMLElement, sessionId: string): void {
  const key = `s:${sessionId}`;
  if (exitingKeys.has(key)) return;
  const li = listEl.querySelector<HTMLLIElement>(`li[data-session-id="${CSS.escape(sessionId)}"]`);
  if (!li || li.classList.contains("row-exiting")) return;
  exitingKeys.add(key);
  stickyExitKeys.add(key);
  // exitingKeys is cleared by reconcileList once the session is absent from
  // entries — not here — to prevent a still-live session from re-entering.

  // Snapshot the in-flow survivors BEFORE the pin reflows them up.
  const survivors = [...listEl.querySelectorAll<HTMLLIElement>("li:not(.row-exiting)")]
    .filter((n) => n !== li);
  const before = new Map<string, DOMRect>();
  for (const n of survivors) {
    const k = keyOf(n);
    if (k) before.set(k, n.getBoundingClientRect());
  }

  beginExit(li);
  flipNodes(survivors, before);
}

export function reconcileList(
  listEl: HTMLElement,
  entries: Array<{ key: string; html: string }>,
  animEnabled: boolean,
): void {
  // Once a session is fully absent from entries the backend has confirmed it's
  // gone — safe to stop suppressing it. A STICKY exit (click-close) that is
  // still in entries stays suppressed so it never re-enters mid-slide-out. A
  // reconcile-driven exit whose key RETURNS to entries revives instead: kill
  // its pinned copy and let it render as a fresh row.
  const allKeys = new Set(entries.map(e => e.key));
  for (const k of exitingKeys) {
    if (!allKeys.has(k)) {
      exitingKeys.delete(k);
      stickyExitKeys.delete(k);
    } else if (!stickyExitKeys.has(k)) {
      exitingKeys.delete(k);
      for (const li of listEl.querySelectorAll<HTMLLIElement>("li.row-exiting")) {
        if (keyOf(li) === k) removeExitNode(li);
      }
    }
  }

  // Strip rows we've already committed to animating out
  const visibleEntries = entries.filter(e => !exitingKeys.has(e.key));

  if (!animEnabled) {
    for (const li of listEl.querySelectorAll<HTMLLIElement>("li.row-exiting")) removeExitNode(li);
    listEl.innerHTML = visibleEntries.map(e => e.html).join("");
    return;
  }

  // Current live nodes (not animating out)
  const existing = new Map<string, HTMLLIElement>();
  for (const li of listEl.querySelectorAll<HTMLLIElement>("li:not(.row-exiting)")) {
    const k = keyOf(li);
    if (k) existing.set(k, li);
  }

  const newKeys = new Set(visibleEntries.map(e => e.key));

  // Read any active FLIP translateY on soon-to-exit rows BEFORE clearing their
  // transform. A prior-cycle exit FLIP-moves these rows: offsetTop lands at the
  // new (post-reflow) slot, but the transform still visually offsets them. We
  // pin at the VISUAL position so each row exits from where the user sees it
  // and not from the same slot as another already-pinned exiting row.
  const exitFlipDy = new Map<HTMLLIElement, number>();
  for (const [k, li] of existing) {
    if (!newKeys.has(k)) {
      const m = getComputedStyle(li).transform;
      exitFlipDy.set(li, m && m !== "none" ? new DOMMatrix(m).m42 : 0);
    }
  }

  // Clear FLIP state on every existing row, not just exiting ones: a surviving
  // row still mid-transition reads getBoundingClientRect at a half-animated
  // position, corrupting dy into a bogus jump even when nothing really moved
  // (interrupting a busy chat fires two reconciles back-to-back into this).
  for (const [, li] of existing) clearFlipState(li);

  // Snapshot positions of rows that will REMAIN before any DOM change.
  const beforeRects = new Map<string, DOMRect>();
  for (const [k, li] of existing) {
    if (newKeys.has(k)) beforeRects.set(k, li.getBoundingClientRect());
  }

  // Batch-capture exit geometry for ALL rows leaving this reconcile BEFORE
  // calling applyPin on any of them. Each applyPin sets position:absolute which
  // reflows siblings — so a second row in the loop would read a post-reflow
  // offsetTop and get pinned at the wrong (often overlapping) position.
  // Add the pre-captured FLIP offset so each row pins at its visual position.
  const exitGeoms = new Map<HTMLLIElement, [number, number, number, number]>();
  for (const [k, li] of existing) {
    if (!newKeys.has(k)) {
      const flipDy = exitFlipDy.get(li) ?? 0;
      exitGeoms.set(li, [li.offsetTop + flipDy, li.offsetLeft, li.offsetWidth, li.offsetHeight]);
    }
  }

  // Now pin and start exit animations using the pre-captured geometry.
  for (const [k, li] of existing) {
    if (!newKeys.has(k)) {
      exitingKeys.add(k);
      const [top, left, width, height] = exitGeoms.get(li)!;
      beginExitAt(li, top, left, width, height);
    }
  }

  // Build ordered node list for the new state
  const nodes: HTMLLIElement[] = [];
  const enterKeys = new Set<string>();
  for (const entry of visibleEntries) {
    const kept = existing.get(entry.key);
    if (kept) {
      updateNode(kept, entry.html);
      nodes.push(kept);
    } else {
      const newLi = parseHtml(entry.html);
      if (newLi) { enterKeys.add(entry.key); nodes.push(newLi); }
    }
  }

  // Reorder + insert synchronously. appendChild on an already-in-DOM node moves
  // it to the end, so iterating the new order produces the correct sequence.
  // Exiting rows are position:absolute (out of flow), so they neither occupy a
  // slot nor get disturbed by this reordering.
  for (const node of nodes) listEl.appendChild(node);

  // Enter animations for new rows
  for (const node of nodes) {
    if (enterKeys.has(keyOf(node))) {
      node.classList.add("row-entering");
      node.addEventListener("animationend", () => node.classList.remove("row-entering"), { once: true });
    }
  }

  // FLIP the surviving rows from their snapshotted positions to their new ones.
  // Rows that markSessionExiting already settled this frame measure dy<0.5 and
  // no-op, so a click-then-reconcile sequence never double-animates.
  flipNodes(nodes, beforeRects);
}
