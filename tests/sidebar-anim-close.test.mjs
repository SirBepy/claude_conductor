// @vitest-environment jsdom
//
// Regression for the close-animation "flash-back": when a session row is
// closed it slides left, the rows below animate up, and then the closed row
// (or the slot it vacated) briefly snaps back before disappearing.
//
// OLD root cause (FLIP design): the exiting <li> used translateX for the
// slide-out, so it kept occupying vertical space. Removing it on `animationend`
// reflowed siblings up, then a deferred FLIP built from stale rects yanked them
// back down for one painted frame — the flash.
//
// NEW design (this contract): the exiting row is taken OUT of layout flow
// (position:absolute) the instant it starts exiting. Siblings reflow up
// immediately and a single, undeferred FLIP slides them. Because the exiting
// row no longer occupies a slot, removing it on `animationend` can't reflow
// anything — the flash-back is structurally impossible, and there is no
// deferral / single-flight scheduler / applyReorder-owns-removal coupling.
//
// Contract under test:
//   - an exiting row is pinned position:absolute (out of flow) on close, and
//   - it is removed on its own `animationend`, OR by a safety timer if no
//     animationend ever fires.

import { describe, it, expect, beforeEach, vi } from "vitest";

// Route rAF through (faked) setTimeout so vi fake timers drive the FLIP.
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);
// jsdom exposes CSS on window but not globalThis; sidebar-anim uses CSS.escape.
if (!globalThis.CSS) globalThis.CSS = window.CSS ?? { escape: (s) => s };

const { reconcileList, markSessionExiting } = await import("../src/views/sessions/sidebar-anim.ts");

function row(id) {
  return { key: `s:${id}`, html: `<li data-session-id="${id}"><span>${id}</span></li>` };
}

function ids(listEl) {
  return [...listEl.querySelectorAll("li[data-session-id]")].map((li) => li.dataset.sessionId);
}

function makeList() {
  const ul = document.createElement("ul");
  ul.className = "sessions-list";
  document.body.appendChild(ul);
  return ul;
}

describe("sidebar close animation", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
  });

  it("pins the exiting row out of flow and removes it on animationend", () => {
    const listEl = makeList();

    // Initial paint: X, A, B (all enter; the reorder runs synchronously).
    reconcileList(listEl, [row("X"), row("A"), row("B")], true);
    vi.runAllTimers();
    expect(ids(listEl)).toEqual(["X", "A", "B"]);

    // User closes X — slide-out begins immediately and X leaves layout flow.
    markSessionExiting(listEl, "X");
    const xLi = listEl.querySelector('li[data-session-id="X"]');
    expect(xLi.classList.contains("row-exiting")).toBe(true);
    expect(xLi.style.position).toBe("absolute");

    // Backend confirms X gone -> reconcile reorders survivors synchronously.
    reconcileList(listEl, [row("A"), row("B")], true);

    // The slide-out finishes and fires animationend. Because X is out of flow,
    // removing it here cannot reflow the survivors — so removal is correct now
    // (the opposite of the old FLIP contract, where this would flash).
    xLi.dispatchEvent(new window.Event("animationend"));
    expect(listEl.querySelector('li[data-session-id="X"]')).toBeNull();
    expect(ids(listEl)).toEqual(["A", "B"]);
  });

  it("removes the exiting row even if no animationend fires (safety net)", () => {
    const listEl = makeList();
    reconcileList(listEl, [row("X"), row("A")], true);
    vi.runAllTimers();

    markSessionExiting(listEl, "X");
    expect(listEl.querySelector('li[data-session-id="X"]')).not.toBeNull();

    // No animationend, no reconcile. The safety timeout must still clean up.
    vi.advanceTimersByTime(3000);
    expect(listEl.querySelector('li[data-session-id="X"]')).toBeNull();
  });

  it("never reorders siblings into a stale layout: end state is correct after a close", () => {
    const listEl = makeList();
    reconcileList(listEl, [row("X"), row("A"), row("B"), row("C")], true);
    vi.runAllTimers();

    markSessionExiting(listEl, "X");
    reconcileList(listEl, [row("A"), row("B"), row("C")], true);
    // Let the slide-out + safety timer resolve so the exiting node is gone.
    vi.runAllTimers();

    expect(ids(listEl)).toEqual(["A", "B", "C"]);
    expect(listEl.querySelectorAll("li.row-exiting").length).toBe(0);
  });
});

// Regression for "chats visible but unclickable / sidebar randomly empty":
// a transient empty reconcile (refresh hiccup, daemon flap) made EVERY row
// exit and enter the suppression set. exitingKeys only cleared when a key was
// ABSENT from entries, so when the sessions came straight back they stayed
// suppressed forever - the only thing left on screen was the pinned
// .row-exiting copies (pointer-events: none -> unclickable), or nothing at
// all once their timers fired. Reconcile-driven exits must REVIVE when their
// key returns; only click-initiated closes (markSessionExiting) stay sticky.
describe("exit suppression revival", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
  });

  it("revives rows whose keys return after a transient empty reconcile", () => {
    const listEl = makeList();
    reconcileList(listEl, [row("A"), row("B")], true);
    vi.runAllTimers();

    // Transient empty refresh: all rows exit + get suppressed. Do NOT advance
    // timers - a hidden window never runs the exit animation or safety timer.
    reconcileList(listEl, [], true);

    // The sessions come straight back.
    reconcileList(listEl, [row("A"), row("B")], true);
    vi.runAllTimers();

    const live = [...listEl.querySelectorAll("li[data-session-id]")]
      .filter((li) => !li.classList.contains("row-exiting"))
      .map((li) => li.dataset.sessionId);
    expect(live).toEqual(["A", "B"]);
    // No unclickable pinned copies may remain.
    expect(listEl.querySelectorAll("li.row-exiting").length).toBe(0);
  });

  it("keeps a click-closed row suppressed while the backend still lists it", () => {
    const listEl = makeList();
    reconcileList(listEl, [row("X"), row("A")], true);
    vi.runAllTimers();

    markSessionExiting(listEl, "X");
    // The backend snapshot still contains X for a few reconciles after the
    // close click - X must NOT re-enter (the original sticky contract).
    reconcileList(listEl, [row("X"), row("A")], true);

    const liveX = [...listEl.querySelectorAll('li[data-session-id="X"]')]
      .filter((li) => !li.classList.contains("row-exiting"));
    expect(liveX.length).toBe(0);

    // Once the backend confirms X gone, the suppression clears.
    reconcileList(listEl, [row("A")], true);
    vi.runAllTimers();
    expect(listEl.querySelector('li[data-session-id="X"]')).toBeNull();
  });
});

// A new chat (the pending draft row) opened WHILE a just-closed row is still
// sliding out must appear immediately — never starved waiting for the close to
// settle. With the out-of-flow design there is no deferral: new rows insert
// synchronously in the same reconcile, so even a burst of instances-changed
// reconciles can't hide the new draft.
describe("new chat opened during a close", () => {
  const pending = () => ({ key: "pending", html: `<li data-pending="1" class="pending">draft</li>` });
  const allIds = (el) =>
    [...el.querySelectorAll("li")].map((li) => li.dataset.sessionId ?? (li.dataset.pending ? "PENDING" : "?"));

  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
  });

  it("inserts the pending row immediately despite a reconcile burst", () => {
    const listEl = makeList();
    reconcileList(listEl, [row("X")], true);
    vi.runAllTimers();

    // Close X, then immediately open a new chat (X still exiting).
    markSessionExiting(listEl, "X");
    reconcileList(listEl, [pending()], true);

    // The new row is visible right away — no "type to reveal", no deferral.
    expect(allIds(listEl)).toContain("PENDING");

    // Storm of instances-changed reconciles under the old settle window: the
    // pending row stays visible throughout.
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(100);
      reconcileList(listEl, [pending()], true);
      expect(allIds(listEl)).toContain("PENDING");
    }

    // The closed row is gone once its slide-out / safety timer resolves.
    vi.runAllTimers();
    expect(listEl.querySelector('li[data-session-id="X"]')).toBeNull();
  });

  // Each draft must carry a DISTINCT key (sidebar keys drafts by placeholderId,
  // not a constant "pending"). A shared key let a discarded draft's exit
  // suppression leak onto the next draft, hiding it until the key changed.
  // Drafts here use distinct `p:<id>` keys to mirror that contract.
  const draft = (id) => ({ key: `p:${id}`, html: `<li class="pending" data-pending="1" data-placeholder-id="${id}">draft</li>` });

  it("shows a new draft opened right after discarding the previous one", () => {
    const listEl = makeList();

    // Open draft #1.
    reconcileList(listEl, [draft("P1")], true);
    vi.runAllTimers();
    expect(allIds(listEl)).toContain("PENDING");

    // Discard draft #1 (it begins exiting), then immediately open draft #2.
    reconcileList(listEl, [], true);
    reconcileList(listEl, [draft("P2")], true);
    vi.runAllTimers();

    // Draft #2 must be visible — not suppressed by draft #1's exit.
    expect(allIds(listEl)).toContain("PENDING");
    expect(listEl.querySelector('li[data-placeholder-id="P2"]')).not.toBeNull();
  });
});

// Regression for "clicking a chat row does nothing": renderSidebar re-runs on
// every background refresh tick (recovery heartbeat, drain-map debounce,
// scheduled-count poll, ...) and rebuilds every row's html string from
// current state, even for rows whose data hasn't changed. If a reconcile with
// an UNCHANGED row's html landed between a click's mousedown and mouseup, the
// old updateNode unconditionally replaced that row's children, detaching the
// mousedown target - and a browser never fires `click` for a detached target,
// so the row looked permanently unclickable. Same mechanism as the Drafts
// panel's focus-refresh bug (6c3db673), different trigger.
describe("unchanged-row reconcile preserves click target", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
  });

  it("keeps a row's inner nodes identical across a reconcile with unchanged html", () => {
    const listEl = makeList();
    reconcileList(listEl, [row("A"), row("B")], true);
    vi.runAllTimers();

    const titleSpan = listEl.querySelector('li[data-session-id="A"] span');
    expect(titleSpan).not.toBeNull();

    // A background refresh tick reconciles with the SAME html for row A - this
    // must be a no-op for A's subtree, as if the user's mousedown already
    // landed on titleSpan and mouseup hasn't fired yet.
    reconcileList(listEl, [row("A"), row("B")], true);

    expect(listEl.querySelector('li[data-session-id="A"] span')).toBe(titleSpan);
  });

  it("still applies a row's html when it actually changes", () => {
    const listEl = makeList();
    const changedRow = (id) => ({ key: `s:${id}`, html: `<li data-session-id="${id}"><span>${id}-updated</span></li>` });

    reconcileList(listEl, [row("A")], true);
    vi.runAllTimers();

    reconcileList(listEl, [changedRow("A")], true);
    expect(listEl.querySelector('li[data-session-id="A"] span').textContent).toBe("A-updated");
  });

  // Same bug, same fix, but for Joe's "Sidebar animations: off" setting (animEnabled
  // false) - that branch used to unconditionally wipe listEl.innerHTML on every
  // reconcile regardless of whether anything changed, so a user with animations
  // disabled still had clicks swallowed by the race this whole fix exists for.
  it("preserves a row's inner nodes with animations disabled too", () => {
    const listEl = makeList();
    reconcileList(listEl, [row("A"), row("B")], false);

    const titleSpan = listEl.querySelector('li[data-session-id="A"] span');
    expect(titleSpan).not.toBeNull();

    reconcileList(listEl, [row("A"), row("B")], false);

    expect(listEl.querySelector('li[data-session-id="A"] span')).toBe(titleSpan);
  });

  it("still applies and removes rows correctly with animations disabled", () => {
    const listEl = makeList();
    const changedRow = (id) => ({ key: `s:${id}`, html: `<li data-session-id="${id}"><span>${id}-updated</span></li>` });

    reconcileList(listEl, [row("A"), row("B")], false);
    reconcileList(listEl, [changedRow("A")], false);

    expect(listEl.querySelector('li[data-session-id="A"] span').textContent).toBe("A-updated");
    expect(listEl.querySelector('li[data-session-id="B"]')).toBeNull();
  });
});
