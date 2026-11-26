// @vitest-environment jsdom
// asserts: src/views/sessions/whats-new/whats-new.ts, src/views/sessions/whats-new/whats-new-state.ts, src/shared/update-toast.ts, src/changelog/entries.ts

// The empty screen's "What's new": the once-per-update flag, the panel markup,
// and the shape of the bundled changelog data.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { getAppVersion } = vi.hoisted(() => ({ getAppVersion: vi.fn() }));
vi.mock("../src/shared/api.ts", () => ({
  api: { getAppVersion: (...a) => getAppVersion(...a), onUpdateStateChange: () => {}, openExternal: () => Promise.resolve() },
}));
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => false }));
const { openCard } = vi.hoisted(() => ({ openCard: vi.fn() }));
vi.mock("../src/views/sessions/whats-new/whats-new-lightbox.ts", () => ({ openWhatsNewCard: (...a) => openCard(...a) }));

const state = await import("../src/views/sessions/whats-new/whats-new-state.ts");
const view = await import("../src/views/sessions/whats-new/whats-new.ts");
const { setupUpdateToast } = await import("../src/shared/update-toast.ts");
const { ENTRIES } = await import("../src/changelog/entries.ts");

const ENTRY = (version, titles) => ({
  version,
  date: "2026-11-16",
  items: titles.map((t) => ({ icon: "ph-sparkle", title: t, caption: `${t} caption`, image: `/img/${t}.png`, alt: `${t} alt` })),
});
const FIXTURE = [ENTRY("2.0.0", ["Big picture", "Second"]), ENTRY("1.0.0", ["Old one"])];

beforeEach(() => {
  localStorage.clear();
  view.resetWhatsNewForTests();
  document.body.innerHTML = "";
});

describe("auto-open flag", () => {
  it("is off with nothing pending", () => {
    expect(state.autoOpenWanted(FIXTURE)).toBe(false);
  });

  it("is on only when the pending version is the newest entry's", () => {
    state.markUpdatedTo("2.0.0");
    expect(state.autoOpenWanted(FIXTURE)).toBe(true);
  });

  it("stays off for an update to a version with no entry", () => {
    state.markUpdatedTo("3.1.4");
    expect(state.autoOpenWanted(FIXTURE)).toBe(false);
  });

  it("announces a detected update so an already-drawn empty screen can open", () => {
    const heard = vi.fn();
    window.addEventListener(state.PENDING_EVENT, heard);
    state.markUpdatedTo("2.0.0");
    window.removeEventListener(state.PENDING_EVENT, heard);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe("update detection records a pending version only for a real update", () => {
  const run = async () => { setupUpdateToast(); await new Promise((r) => setTimeout(r, 0)); };

  it("an update (stored version differs) marks the running version pending", async () => {
    localStorage.setItem("lastSeenAppVersion", "0.2.153");
    getAppVersion.mockResolvedValue("0.2.154");
    await run();
    expect(state.pendingVersion()).toBe("0.2.154");
  });

  it("a fresh install (nothing stored) marks nothing", async () => {
    getAppVersion.mockResolvedValue("0.2.154");
    await run();
    expect(state.pendingVersion()).toBeNull();
    expect(localStorage.getItem("lastSeenAppVersion")).toBe("0.2.154");
  });

  it("the same version again marks nothing", async () => {
    localStorage.setItem("lastSeenAppVersion", "0.2.154");
    getAppVersion.mockResolvedValue("0.2.154");
    await run();
    expect(state.pendingVersion()).toBeNull();
  });
});

describe("panel markup", () => {
  it("renders nothing without entries", () => {
    expect(view.whatsNewHtml([])).toBe("");
  });

  it("is a button, not the panel, when nothing is pending", () => {
    const html = view.whatsNewHtml(FIXTURE);
    expect(html).toContain('class="wn-host"');
    expect(html).toContain("wn-btn");
    expect(html).toContain("v2.0.0");
    expect(html).not.toContain("<section");
  });

  it("opens by itself on a pending update and keeps the panel across re-renders", () => {
    state.markUpdatedTo("2.0.0");
    const html = view.whatsNewHtml(FIXTURE);
    expect(html).toContain("wn-panel");
    expect(html).toContain("What's new in v2.0.0");
    expect((html.match(/class="wn-card[ "]/g) ?? []).length).toBe(2);
    // The empty state is redrawn on daemon changes: the panel must survive.
    expect(view.whatsNewHtml(FIXTURE)).toContain("wn-panel");
  });

  it("spends the flag only once the panel has stayed on screen, not on a draw that was replaced", () => {
    vi.useFakeTimers();
    try {
      state.markUpdatedTo("2.0.0");
      // Drawn, then replaced before it was ever attached (the restore of the last chat).
      view.whatsNewHtml(FIXTURE);
      vi.advanceTimersByTime(view.SEEN_AFTER_MS + 50);
      expect(state.pendingVersion()).toBe("2.0.0");

      // Drawn and still there: seen.
      document.body.innerHTML = view.whatsNewHtml(FIXTURE);
      vi.advanceTimersByTime(view.SEEN_AFTER_MS + 50);
      expect(state.pendingVersion()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a later draw restarts the wait, so a replaced draw cannot make its successor count as seen early", () => {
    vi.useFakeTimers();
    try {
      state.markUpdatedTo("2.0.0");
      view.whatsNewHtml(FIXTURE); // draw A, replaced at once
      vi.advanceTimersByTime(view.SEEN_AFTER_MS - 100);
      document.body.innerHTML = view.whatsNewHtml(FIXTURE); // draw B stays
      vi.advanceTimersByTime(150); // A's original deadline passes
      expect(state.pendingVersion()).toBe("2.0.0");
      vi.advanceTimersByTime(view.SEEN_AFTER_MS);
      expect(state.pendingVersion()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a panel drawn while the window is hidden is spent once the window shows", () => {
    vi.useFakeTimers();
    const vis = vi.spyOn(document, "visibilityState", "get");
    try {
      // The visibility listener reads the bundled entries, so this one uses them.
      const newest = ENTRIES[0].version;
      state.markUpdatedTo(newest);
      vis.mockReturnValue("hidden");
      document.body.innerHTML = view.whatsNewHtml();
      vi.advanceTimersByTime(view.SEEN_AFTER_MS + 50);
      expect(state.pendingVersion()).toBe(newest);

      vis.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(view.SEEN_AFTER_MS + 50);
      expect(state.pendingVersion()).toBeNull();
    } finally {
      vis.mockRestore();
      vi.useRealTimers();
    }
  });

  it("escapes entry text", () => {
    state.markUpdatedTo("2.0.0");
    const open = view.whatsNewHtml([ENTRY("2.0.0", ['<img src=x onerror="boom()">'])]);
    expect(open).toContain("wn-card-title");
    expect(open).not.toContain("<img src=x");
    expect(open).toContain("&lt;img src=x");
  });
});

describe("clicks (the document-level listener)", () => {
  const mount = () => {
    document.body.innerHTML = `<div id="pane">${view.whatsNewHtml()}</div>`;
    return document.getElementById("pane");
  };

  it("the button opens the newest entry, a tab switches entry, Close puts it away", () => {
    const pane = mount();
    pane.querySelector("[data-wn='open']").click();
    expect(pane.querySelector("h2").textContent).toBe(`What's new in v${ENTRIES[0].version}`);

    const older = ENTRIES[1];
    pane.querySelector(`[data-wn-version="${older.version}"]`).click();
    expect(pane.querySelector("h2").textContent).toBe(`What's new in v${older.version}`);
    expect(pane.querySelectorAll(".wn-card").length).toBe(older.items.length);

    pane.querySelector("[data-wn='close']").click();
    expect(pane.querySelector(".wn-panel")).toBeNull();
    expect(pane.querySelector(".wn-btn")).not.toBeNull();
    // The button names the newest entry, not the tab that was last looked at.
    expect(pane.querySelector(".wn-btn-ver").textContent).toBe(`v${ENTRIES[0].version}`);
  });

  it("Close stays closed even while an update is still pending", () => {
    const pane = mount();
    state.markUpdatedTo(ENTRIES[0].version);
    expect(pane.querySelector(".wn-panel")).not.toBeNull();
    pane.querySelector("[data-wn='close']").click();
    expect(pane.querySelector(".wn-panel")).toBeNull();
    expect(state.pendingVersion()).toBeNull();
  });

  it("an update detected after the empty screen drew opens the panel", () => {
    const pane = mount();
    expect(pane.querySelector(".wn-panel")).toBeNull();
    state.markUpdatedTo(ENTRIES[0].version);
    expect(pane.querySelector(".wn-panel")).not.toBeNull();
  });
});

describe("keyboard and screen reader wiring", () => {
  const mount = () => {
    document.body.innerHTML = `<div id="pane">${view.whatsNewHtml()}</div>`;
    return document.getElementById("pane");
  };
  const paint = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 0))));

  it("the opener says it is collapsed and names the panel it controls", () => {
    const pane = mount();
    const btn = pane.querySelector("[data-wn='open']");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    btn.click();
    const panel = pane.querySelector(".wn-panel");
    expect(btn.getAttribute("aria-controls")).toBe(panel.id);
    // The Close button sits inside the panel it closes: expanded/controls belong to the opener only.
    expect(pane.querySelector("[data-wn='close']").hasAttribute("aria-expanded")).toBe(false);
  });

  it("a redraw nobody asked focus for keeps focus on the same control", () => {
    const pane = mount();
    pane.querySelector("[data-wn='open']").click();
    const tab = pane.querySelector("[role='tab'][aria-selected='false']");
    tab.click();
    const selected = pane.querySelector("[role='tab'][aria-selected='true']");
    selected.focus();
    window.dispatchEvent(new CustomEvent(state.PENDING_EVENT));
    expect(document.activeElement).toBe(pane.querySelector("[role='tab'][aria-selected='true']"));
    expect(document.activeElement).not.toBe(selected);
    pane.querySelector("[data-wn='close']").focus();
    window.dispatchEvent(new CustomEvent(state.PENDING_EVENT));
    expect(document.activeElement).toBe(pane.querySelector("[data-wn='close']"));
  });

  it("modified arrow keys are left to the browser", () => {
    const pane = mount();
    pane.querySelector("[data-wn='open']").click();
    const first = pane.querySelector("[role='tab'][aria-selected='true']");
    first.focus();
    const ev = new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true, cancelable: true });
    first.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(pane.querySelector("[role='tab'][aria-selected='true']").dataset.wnVersion).toBe(ENTRIES[0].version);
  });

  it("a key event dispatched on the document itself is ignored, not an error", () => {
    mount();
    const errors = [];
    const onError = (e) => { errors.push(e.message); e.preventDefault(); };
    window.addEventListener("error", onError);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    window.removeEventListener("error", onError);
    expect(errors).toEqual([]);
  });

  it("tabs control one tabpanel that is labelled by the selected tab", () => {
    const pane = mount();
    pane.querySelector("[data-wn='open']").click();
    const grid = pane.querySelector("[role='tabpanel']");
    const selected = pane.querySelector("[role='tab'][aria-selected='true']");
    expect(selected.getAttribute("aria-controls")).toBe(grid.id);
    expect(grid.getAttribute("aria-labelledby")).toBe(selected.id);
    // Roving tabindex: only the selected tab is reachable with Tab.
    expect([...pane.querySelectorAll("[role='tab']")].filter((t) => t.tabIndex === 0)).toEqual([selected]);
    pane.querySelector("[role='tab'][aria-selected='false']").click();
    const now = pane.querySelector("[role='tab'][aria-selected='true']");
    expect(now).not.toBe(selected);
    expect(pane.querySelector("[role='tabpanel']").getAttribute("aria-labelledby")).toBe(now.id);
  });

  it("focus follows the control that replaced the one clicked", () => {
    const pane = mount();
    pane.querySelector("[data-wn='open']").click();
    expect(document.activeElement).toBe(pane.querySelector("[data-wn='close']"));
    pane.querySelector("[role='tab'][aria-selected='false']").click();
    expect(document.activeElement).toBe(pane.querySelector("[role='tab'][aria-selected='true']"));
    pane.querySelector("[data-wn='close']").click();
    expect(document.activeElement).toBe(pane.querySelector("[data-wn='open']"));
  });

  it("arrow keys move between tabs and keep focus on the new tab", () => {
    const pane = mount();
    pane.querySelector("[data-wn='open']").click();
    const first = pane.querySelector("[role='tab'][aria-selected='true']");
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    const second = pane.querySelector("[role='tab'][aria-selected='true']");
    expect(second.dataset.wnVersion).toBe(ENTRIES[1].version);
    expect(document.activeElement).toBe(second);
    second.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
    expect(pane.querySelector("[role='tab'][aria-selected='true']").dataset.wnVersion).toBe(ENTRIES[0].version);
  });

  it("only the draw that opened the panel carries the grow-in class", async () => {
    const pane = mount();
    pane.querySelector("[data-wn='open']").click();
    expect(pane.querySelector(".wn-panel").classList.contains("is-opening")).toBe(true);
    await paint();
    // A redraw of the open panel (daemon change, tab switch) must not replay it.
    pane.querySelector("[role='tab'][aria-selected='false']").click();
    expect(pane.querySelector(".wn-panel").classList.contains("is-opening")).toBe(false);
    pane.innerHTML = view.whatsNewHtml();
    expect(pane.querySelector(".wn-panel").classList.contains("is-opening")).toBe(false);
  });

  it("an auto-opened panel grows in once too", async () => {
    state.markUpdatedTo(ENTRIES[0].version);
    expect(view.whatsNewHtml()).toContain("is-opening");
    await paint();
    expect(view.whatsNewHtml()).not.toContain("is-opening");
  });
});

describe("cards open their picture in the lightbox", () => {
  const mount = () => {
    document.body.innerHTML = `<div id="pane">${view.whatsNewHtml()}</div>`;
    const pane = document.getElementById("pane");
    pane.querySelector("[data-wn='open']").click();
    openCard.mockClear();
    return pane;
  };

  it("a card is a focusable button with a pointer-style hook", () => {
    const card = mount().querySelector(".wn-card");
    expect(card.getAttribute("role")).toBe("button");
    expect(card.tabIndex).toBe(0);
    expect(card.classList.contains("is-openable")).toBe(true);
    expect(card.getAttribute("aria-label")).toContain(ENTRIES[0].items[0].title);
  });

  it("a click on the text or the picture opens that card with the release's items", () => {
    const pane = mount();
    pane.querySelectorAll(".wn-card")[1].querySelector(".wn-card-caption").click();
    expect(openCard).toHaveBeenCalledTimes(1);
    expect(openCard).toHaveBeenCalledWith(ENTRIES[0].items, 1);
    pane.querySelectorAll(".wn-card")[0].querySelector(".wn-shot").click();
    expect(openCard).toHaveBeenLastCalledWith(ENTRIES[0].items, 0);
    // The panel is not redrawn behind the lightbox.
    expect(pane.querySelectorAll(".wn-card").length).toBe(ENTRIES[0].items.length);
  });

  it("Enter and Space open the focused card without scrolling the page", () => {
    const pane = mount();
    const card = pane.querySelectorAll(".wn-card")[2];
    card.focus();
    for (const key of ["Enter", " "]) {
      const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      card.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
    }
    expect(openCard).toHaveBeenCalledTimes(2);
    expect(openCard).toHaveBeenLastCalledWith(ENTRIES[0].items, 2);
  });

  it("the Done card's release dialog draws plain cards that do nothing", () => {
    const html = view.whatsNewReleaseHtml(ENTRIES[0].version);
    expect(html).not.toContain("is-openable");
    expect(html).not.toContain('data-wn="card"');
  });
});

describe("bundled changelog data", () => {
  it("is newest first with unique versions and ISO dates", () => {
    const versions = ENTRIES.map((e) => e.version);
    expect(new Set(versions).size).toBe(versions.length);
    const key = (v) => v.split(".").map(Number);
    for (let i = 1; i < versions.length; i++) {
      const [a, b] = [key(versions[i - 1]), key(versions[i])];
      const newer = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
      expect(newer).toBeGreaterThan(0);
    }
    for (const e of ENTRIES) expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("keeps every item visual and short: a picture, a Phosphor icon, a title and one line", () => {
    for (const e of ENTRIES) {
      expect(e.items.length).toBeGreaterThan(0);
      for (const it of e.items) {
        expect(it.image).toBeTruthy();
        expect(it.alt.length).toBeGreaterThan(0);
        expect(it.icon).toMatch(/^ph-[a-z0-9-]+$/);
        expect(it.title.length).toBeLessThanOrEqual(40);
        expect(it.caption.length).toBeLessThanOrEqual(120);
        expect(`${it.title}${it.caption}${it.alt}`).not.toContain(String.fromCharCode(8212));
      }
    }
  });
});
