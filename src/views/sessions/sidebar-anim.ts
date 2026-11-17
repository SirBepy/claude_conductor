import { cancelTitleSwap, titleShown, titleTarget, typeSwap } from "../../shared/title-typewriter";

export const LS_ANIM = "cc_sidebar_animations";

const TITLE_SEL = ".session-row-title-text";

/** Motion and patching choices of one list. The session rows use none of them (bouncy FLIP,
 *  whole-row swap); the chat heads ask for a calm FLIP, a staggered enter and exit that
 *  travels from the toggle, and a patch that touches only the parts that changed. */
export interface ReconcileOpts {
  /** Brings `kept` up to date with `fresh` without replacing its insides. `prevHtml` is what
   *  `kept` was last built from. Returns false to fall back to the whole-row swap. */
  patch?: (kept: HTMLLIElement, fresh: HTMLLIElement, prevHtml: string | undefined) => boolean;
  /** Calm FLIP: a plain ease-out slide, no overshoot, no lift. */
  softFlip?: boolean;
  /** A batch of rows entering or leaving together starts this many ms apart (enter in order,
   *  exit in reverse) and each row travels from or to the row keyed `anchorKey`. The whole
   *  stagger spans at most `maxSpanMs`. */
  stagger?: { enterMs: number; exitMs: number; anchorKey?: string; maxSpanMs: number };
}

const listOpts = new WeakMap<HTMLElement, ReconcileOpts>();
const FLIP_SOFT_MS = 320;

/** The next reconcile, within 200ms, skips its FLIP. A drop that has already slid every head
 *  into its slot clears the transforms and reorders in one frame, so a FLIP would replay the
 *  move. The window keeps a render that never comes from muting a later, real one. */
let skipFlipUntil = 0;
export function holdFlipOnce(): void { skipFlipUntil = performance.now() + 200; }

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
  // Nothing in flight: leave the row's own CSS transitions (a head's step and ring) alone.
  // An inline transition:none here would silence them for the class change that follows.
  if (!li.style.transform && !li.style.transition && !li.style.boxShadow && !li.style.zIndex) return;
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
  // A child's own animation bubbles its animationend up to the row; only the row's exit
  // animation may remove it.
  li.addEventListener("animationend", (e) => { if (e.target === li) removeExitNode(li); });
  exitTimers.set(li, setTimeout(() => removeExitNode(li), EXIT_SAFETY_MS));
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

// > the longest row motion: a rising FLIP row's 0.34s lift + 0.15s settle.
const SETTLE_MS = 600;
const settleTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

// Overshooting slides and FLIPs briefly push rows past the list's edges (the
// Hidden header pinned to the bottom bounces below it), which flashes a
// scrollbar for a list that fits. Suppress vertical scrolling for the duration,
// but only when the settled layout fits, so a genuine scrollbar never vanishes.
function suppressTransientScrollbar(listEl: HTMLElement): void {
  const inFlow = listEl.querySelectorAll<HTMLLIElement>("li:not(.row-exiting)");
  const last = inFlow[inFlow.length - 1];
  const contentBottom = last ? last.offsetTop + last.offsetHeight : 0;
  const pad = parseFloat(getComputedStyle(listEl).paddingBottom) || 0;
  if (contentBottom + pad > listEl.clientHeight) return;
  listEl.classList.add("anim-settling");
  clearTimeout(settleTimers.get(listEl));
  settleTimers.set(listEl, setTimeout(() => listEl.classList.remove("anim-settling"), SETTLE_MS));
}

// Every renderSidebar call rebuilds every row's html string from current
// state, even rows whose data hasn't changed (e.g. a background refresh
// tick for a different session). Without this, updateNode would wipe and
// rebuild a kept row's children on every such pass - and if a click's
// mousedown lands on a child (title text, icon) that gets detached between
// mousedown and mouseup, the browser never fires the click at all. Same
// mechanism as the Drafts panel's focus-refresh bug (6c3db673), different
// trigger (periodic re-render, not just window focus).
const lastRowHtml = new WeakMap<HTMLLIElement, string>();

function updateNode(kept: HTMLLIElement, html: string, animEnabled: boolean, opts?: ReconcileOpts): void {
  const prevHtml = lastRowHtml.get(kept);
  if (prevHtml === html) return;
  const tmp = document.createElement("ul");
  tmp.innerHTML = html;
  const fresh = tmp.firstElementChild as HTMLLIElement | null;
  if (!fresh) return;
  // Dropping the entrance class mid-flight would cancel the animation and pop the row.
  const entering = kept.classList.contains("row-entering") ? " row-entering" : "";
  const patched = !!opts?.patch?.(kept, fresh, prevHtml);
  if (patched) {
    const cls = fresh.className + entering;
    if (kept.className !== cls) kept.className = cls;
    for (const attr of fresh.attributes) {
      if (attr.name !== "class" && kept.getAttribute(attr.name) !== attr.value) kept.setAttribute(attr.name, attr.value);
    }
    if (!fresh.hasAttribute("data-kbd-hint")) kept.removeAttribute("data-kbd-hint");
    lastRowHtml.set(kept, html);
    return;
  }
  const oldTitleEl = kept.querySelector<HTMLElement>(TITLE_SEL);
  const oldTarget = oldTitleEl ? titleTarget(oldTitleEl) : null;
  const oldShown = oldTitleEl ? titleShown(oldTitleEl) : null;
  if (oldTitleEl) cancelTitleSwap(oldTitleEl);
  kept.className = fresh.className + entering;
  kept.innerHTML = fresh.innerHTML;
  // The innerHTML swap above holds the final title already; retype it from what
  // the old row was showing. A row whose title did not change is left alone,
  // except one caught mid-swap, which carries on from its half-typed text.
  const newTitleEl = kept.querySelector<HTMLElement>(TITLE_SEL);
  if (animEnabled && oldTitleEl && newTitleEl && oldShown != null) {
    const next = newTitleEl.textContent ?? "";
    if (oldTarget !== next || oldShown !== next) typeSwap(newTitleEl, next, { from: oldShown });
  }
  for (const attr of fresh.attributes) {
    if (attr.name !== "class") kept.setAttribute(attr.name, attr.value);
  }
  // Only the Ctrl+N badge is conditional (rows past the 9th have none); a stale
  // one would show a duplicate number on a row that dropped out of the top 9.
  if (!fresh.hasAttribute("data-kbd-hint")) kept.removeAttribute("data-kbd-hint");
  lastRowHtml.set(kept, html);
}

function parseHtml(html: string): HTMLLIElement | null {
  const tmp = document.createElement("ul");
  tmp.innerHTML = html;
  return tmp.firstElementChild as HTMLLIElement | null;
}

function flipNodes(nodes: HTMLLIElement[], beforeRects: Map<string, DOMRect>, soft = false): void {
  requestAnimationFrame(() => {
    // Measure pass: classify each move and find the bottom-most RISING row.
    // Only that row casts the lift shadow — otherwise every rising row drops
    // its own shadow onto the row beneath it, so a group moving up stacks a
    // pile of shadows on the bottom element. One shadow, under the whole group.
    const moves: Array<{ node: HTMLLIElement; dx: number; dy: number; rising: boolean }> = [];
    let bottomRiser: HTMLLIElement | null = null;
    let bottomRiserTop = -Infinity;
    for (const node of nodes) {
      const k = keyOf(node);
      if (!beforeRects.has(k)) continue;
      const rect = node.getBoundingClientRect();
      const top = rect.top;
      const dy = beforeRects.get(k)!.top - top;
      // Only a calm FLIP follows a head into the next column.
      const dx = soft ? beforeRects.get(k)!.left - rect.left : 0;
      if (Math.abs(dy) < 0.5 && Math.abs(dx) < 0.5) continue;
      const rising = dy > 20;
      moves.push({ node, dx, dy, rising });
      if (rising && top > bottomRiserTop) { bottomRiserTop = top; bottomRiser = node; }
    }

    // Invert: jump each row to its old position with no transition.
    for (const { node, dx, dy } of moves) {
      node.style.transition = "none";
      node.style.transform = soft ? `translate(${dx}px, ${dy}px)` : `translateY(${dy}px)`;
    }
    // A row that did not move gets its own CSS transitions back (clearFlipState silenced a
    // row that was mid-slide so it could be measured).
    const moved = new Set(moves.map((m) => m.node));
    for (const node of nodes) if (!moved.has(node) && node.style.transition === "none") node.style.transition = "";

    // Play: animate every row to its final spot next frame.
    requestAnimationFrame(() => {
      for (const { node, rising } of moves) {
        if (soft && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
          // Reduced motion: a head that lost its neighbour does not travel to the gap.
          node.style.transition = "";
          node.style.transform = "";
        } else if (soft) {
          // A plain ease-out slide (the project's easing), interruptible: the next reconcile
          // clears it and measures again.
          node.style.transition = `transform ${FLIP_SOFT_MS}ms var(--motion-ease)`;
          node.style.transform = "";
          const done = (e: TransitionEvent): void => {
            if (e.target !== node || e.propertyName !== "transform") return;
            node.style.transition = "";
            node.removeEventListener("transitionend", done);
          };
          node.addEventListener("transitionend", done);
        } else if (rising) {
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
  const li = listEl.querySelector<HTMLLIElement>(`li[data-session-id="${CSS.escape(sessionId)}"]`);
  if (!li || li.classList.contains("row-exiting")) return;
  // Read the key off the row rather than rebuilding it from the id: a respawn
  // successor's row is keyed by the chat it took over from, so the two forms
  // diverge and the reconciler would never clear a hand-built one.
  const key = keyOf(li);
  if (!key || exitingKeys.has(key)) return;
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
  suppressTransientScrollbar(listEl);
  flipNodes(survivors, before, !!listOpts.get(listEl)?.softFlip);
}

/** Puts `nodes` in order inside `listEl`, moving only a row that is out of place. Moving a
 *  node detaches and re-attaches it, which restarts everything the pointer was doing to it
 *  (the hover state, a press, a transition in flight): re-appending every row on each render
 *  made a hovered head bounce on every status update. */
function placeNodes(listEl: HTMLElement, nodes: HTMLLIElement[]): void {
  const inFlow = (el: Element | null): Element | null => {
    while (el && el.classList.contains("row-exiting")) el = el.nextElementSibling;
    return el;
  };
  let cursor = inFlow(listEl.firstElementChild);
  for (const node of nodes) {
    if (node === cursor) cursor = inFlow(cursor.nextElementSibling);
    else listEl.insertBefore(node, cursor);
  }
}

/** The stagger step for `n` rows: the configured step, shrunk so the last row still starts
 *  within `maxSpanMs`. */
function staggerStep(stepMs: number, n: number, maxSpanMs: number): number {
  return n > 1 ? Math.min(stepMs, maxSpanMs / (n - 1)) : 0;
}

/** Ends an enter: the class goes, and so do the per-row custom properties it read. */
function finishEnter(node: HTMLLIElement): void {
  // The fallback timer fires long after a normal end, when the node may be on its way out
  // with its own delay and travel.
  if (!node.classList.contains("row-entering")) return;
  node.classList.remove("row-entering");
  node.style.removeProperty("--stagger-delay");
  node.style.removeProperty("--travel-x");
  node.style.removeProperty("--travel-y");
}

export function reconcileList(
  listEl: HTMLElement,
  entries: Array<{ key: string; html: string }>,
  animEnabled: boolean,
  opts?: ReconcileOpts,
): void {
  if (opts) listOpts.set(listEl, opts);
  const skipFlip = performance.now() < skipFlipUntil;
  skipFlipUntil = 0;
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

  // Current live nodes (not animating out)
  const existing = new Map<string, HTMLLIElement>();
  for (const li of listEl.querySelectorAll<HTMLLIElement>("li:not(.row-exiting)")) {
    const k = keyOf(li);
    if (k) existing.set(k, li);
  }

  if (!animEnabled) {
    for (const li of listEl.querySelectorAll<HTMLLIElement>("li.row-exiting")) removeExitNode(li);
    // Same keyed reuse as the animated path below (updateNode no-ops an
    // unchanged row, so a click surviving mid-reconcile isn't FLIP-exclusive) -
    // just without any FLIP/enter/exit choreography.
    const keptKeys = new Set(visibleEntries.map(e => e.key));
    for (const [k, li] of existing) {
      if (!keptKeys.has(k)) li.remove();
    }
    const nodes: HTMLLIElement[] = [];
    for (const entry of visibleEntries) {
      const kept = existing.get(entry.key);
      if (kept) {
        updateNode(kept, entry.html, animEnabled, opts);
        nodes.push(kept);
      } else {
        const newLi = parseHtml(entry.html);
        if (newLi) { nodes.push(newLi); lastRowHtml.set(newLi, entry.html); }
      }
    }
    placeNodes(listEl, nodes);
    return;
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

  // A batch of heads leaving together goes in reverse order, each toward the anchor row (the
  // toggle), so closing the stack mirrors opening it.
  const stagger = opts?.stagger;
  const anchorKept = stagger?.anchorKey ? existing.get(stagger.anchorKey) : undefined;
  const anchorGeo: [number, number] | null = anchorKept && newKeys.has(stagger!.anchorKey!) ? [anchorKept.offsetTop, anchorKept.offsetLeft] : null;
  const leaving = [...exitGeoms.keys()];
  const exitStep = stagger ? staggerStep(stagger.exitMs, leaving.length, stagger.maxSpanMs) : 0;

  // Now pin and start exit animations using the pre-captured geometry.
  for (const [k, li] of existing) {
    if (!newKeys.has(k)) {
      exitingKeys.add(k);
      const [top, left, width, height] = exitGeoms.get(li)!;
      if (stagger) {
        li.style.setProperty("--stagger-delay", `${Math.round((leaving.length - 1 - leaving.indexOf(li)) * exitStep)}ms`);
        if (anchorGeo) {
          li.style.setProperty("--travel-x", `${anchorGeo[1] - left}px`);
          li.style.setProperty("--travel-y", `${anchorGeo[0] - top}px`);
        } else {
          // A head that left while its own enter was still running carries that enter's travel.
          li.style.removeProperty("--travel-x");
          li.style.removeProperty("--travel-y");
        }
      }
      beginExitAt(li, top, left, width, height);
    }
  }

  // Build ordered node list for the new state
  const nodes: HTMLLIElement[] = [];
  const enterKeys = new Set<string>();
  for (const entry of visibleEntries) {
    const kept = existing.get(entry.key);
    if (kept) {
      updateNode(kept, entry.html, animEnabled, opts);
      nodes.push(kept);
    } else {
      const newLi = parseHtml(entry.html);
      if (newLi) {
        enterKeys.add(entry.key);
        nodes.push(newLi);
        lastRowHtml.set(newLi, entry.html);
      }
    }
  }

  // Reorder + insert synchronously. Exiting rows are position:absolute (out of flow), so
  // they neither occupy a slot nor get disturbed by this reordering.
  placeNodes(listEl, nodes);

  // Enter animations for new rows. Geometry is read for the whole batch before any write.
  const entering = nodes.filter((n) => enterKeys.has(keyOf(n)));
  const anchorNode = stagger?.anchorKey ? nodes.find((n) => keyOf(n) === stagger.anchorKey) : undefined;
  const enterGeo = anchorNode && stagger
    ? entering.map((n) => (n === anchorNode ? null : ([n.offsetTop, n.offsetLeft] as const)))
    : [];
  const moving = entering.filter((n) => n !== anchorNode);
  const enterStep = stagger ? staggerStep(stagger.enterMs, moving.length, stagger.maxSpanMs) : 0;
  // The anchor entering with the rest means the list itself is arriving (the view just
  // mounted, or the first chats came in beside the lone + head): it appears in place.
  const arriving = !!anchorNode && entering.includes(anchorNode);
  entering.forEach((node, i) => {
    if (arriving) return;
    if (stagger) {
      node.style.setProperty("--stagger-delay", `${Math.round(moving.indexOf(node) * enterStep)}ms`);
      const geo = enterGeo[i];
      if (anchorNode && geo) {
        node.style.setProperty("--travel-x", `${anchorNode.offsetLeft - geo[1]}px`);
        node.style.setProperty("--travel-y", `${anchorNode.offsetTop - geo[0]}px`);
      } else if (anchorNode) {
        node.style.setProperty("--travel-x", "0px");
        node.style.setProperty("--travel-y", "0px");
      }
    }
    node.classList.add("row-entering");
    node.addEventListener("animationend", (e) => { if (e.target === node) finishEnter(node); });
    // A list whose CSS draws no entrance would keep the class for good.
    setTimeout(() => finishEnter(node), EXIT_SAFETY_MS + (stagger?.maxSpanMs ?? 0));
  });

  // FLIP the surviving rows from their snapshotted positions to their new ones.
  // Rows that markSessionExiting already settled this frame measure dy<0.5 and
  // no-op, so a click-then-reconcile sequence never double-animates.
  suppressTransientScrollbar(listEl);
  if (skipFlip) {
    for (const node of nodes) if (node.style.transition === "none") node.style.transition = "";
  } else flipNodes(nodes, beforeRects, !!opts?.softFlip);
}
