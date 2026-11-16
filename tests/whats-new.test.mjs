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
    expect(html).not.toContain("wn-panel");
  });

  it("opens by itself on a pending update and keeps the panel across re-renders", () => {
    state.markUpdatedTo("2.0.0");
    const html = view.whatsNewHtml(FIXTURE);
    expect(html).toContain("wn-panel");
    expect(html).toContain("What's new in v2.0.0");
    expect((html.match(/class="wn-card"/g) ?? []).length).toBe(2);
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
