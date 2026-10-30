// @vitest-environment jsdom
//
// The dashboard's tighter cards: the Chats list (live chats in status order,
// then the most recently closed), Next up summaries and paging, the Past
// results footer and its modal, the quick-action chip row, and custom-card
// auto-refresh. The custom-card extras live in project-dashboard-card-extras.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { dash, invoke, mount, resetDashboard, state, resolveNewChatConfig } from "./helpers/project-dashboard-cards-setup.mjs";
import { card as cardView, history, mixedChats, planItems, projectSnapshot } from "./helpers/project-dashboard-fixtures.mjs";

beforeEach(resetDashboard);

describe("Chats card", () => {
  const rowsText = (root) => [...root.querySelectorAll('[data-pd-card="chats"] .pd-row .pd-t')].map((n) => n.textContent);
  const label = (root) => root.querySelector('[data-pd-card="chats"] [data-pd-past-label]');
  const recent = (n) => Array.from({ length: n }, (_, i) => ({ session_id: `old-${i}`, title: `old-${i}`, status: "ended", repo_cwd: "C:/Projects/conductor", at_ms: Date.now() - (i + 1) * 60_000 }));

  it("lists live chats in the sidebar's group order with no gap between groups, 4 a page, then the closed ones", async () => {
    dash.snapshot = projectSnapshot({ chats_running: mixedChats() });
    const root = await mount({ kind: "project", id: "p1" });
    expect(rowsText(root)).toEqual(["ask-a", "work-a", "work-b", "wait-a", "Phone question sheet peek"]);
    expect(root.querySelectorAll('[data-pd-card="chats"] .pd-row.is-gap')).toHaveLength(0);
    expect(label(root).textContent).toBe("Recently closed");
    expect(root.querySelector('[data-pd-pager="chats"] .pd-pg-n').textContent).toBe("1/2");

    // The pager pages the live chats only; the closed ones stay under them.
    root.querySelector('[data-pd-pager="chats"] button[title="Next"]').click();
    await vi.waitFor(() => expect(rowsText(root)).toEqual(["done-a", "Phone question sheet peek"]));
    expect(root.querySelector('[data-pd-pager="chats"] button[title="Next"]').disabled).toBe(true);
  });

  it("shows at most three closed chats, muted, each opening its history; no tabs, a History button instead", async () => {
    dash.snapshot = projectSnapshot({ chats_running: mixedChats().slice(0, 2), chats_recent: recent(5) });
    const root = await mount({ kind: "project", id: "p1" });
    expect(root.querySelector('[data-pd-pager="chats"]')).toBeNull();
    expect(rowsText(root)).toEqual(["ask-a", "work-a", "old-0", "old-1", "old-2"]);
    expect(root.querySelectorAll('[data-pd-card="chats"] .pd-t .pd-muted')).toHaveLength(3);
    expect(root.querySelector('[data-pd-card="chats"] .pd-rtab')).toBeNull();
    expect(root.querySelector('[data-pd-card="chats"] [data-pd-all-history]').title).toBe("History");
  });

  it("drops the Recently closed label when there are no live chats above it", async () => {
    dash.snapshot = projectSnapshot({ chats_running: [], chats_recent: recent(2) });
    const root = await mount({ kind: "project", id: "p1" });
    expect(rowsText(root)).toEqual(["old-0", "old-1"]);
    expect(label(root)).toBeNull();
  });
});

describe("Next up", () => {
  const rows = (root) => [...root.querySelectorAll('[data-pd-card="next_up"] .pd-row')];

  it("shows the first three items cut to a headline with the full text as the tooltip, no subheadings", async () => {
    dash.snapshot = projectSnapshot({ plan: planItems(), scheduled: [] });
    const root = await mount({ kind: "project", id: "p1" });
    expect(rows(root).map((r) => r.querySelector(".pd-t").textContent)).toEqual([
      "#68 low priority: Shortcut hygiene",
      "#88 wire the Amplitude SDK",
      "#89 Short one",
    ]);
    expect(rows(root)[0].title).toContain("decide on a ticket template");
    expect(root.querySelectorAll('[data-pd-card="next_up"] .pd-sub')).toHaveLength(0);
  });

  it("pages the rest three at a time and caps Scheduled at two rows", async () => {
    const at = Date.now() + 3_600_000;
    dash.snapshot = projectSnapshot({
      plan: planItems(),
      scheduled: [1, 2, 3].map((n) => ({ id: `s${n}`, label: `job ${n}`, fire_at_ms: at, repo_cwd: "C:/Projects/conductor" })),
    });
    const root = await mount({ kind: "project", id: "p1" });
    expect(root.querySelector('[data-pd-pager="next_up"] .pd-pg-n').textContent).toBe("1/2");
    expect(rows(root).filter((r) => r.querySelector(".ph-alarm"))).toHaveLength(2);

    root.querySelector('[data-pd-pager="next_up"] button[title="Next"]').click();
    await vi.waitFor(() => expect(rows(root)[0].querySelector(".pd-t").textContent).toBe("#90 [P] - BP Amplitude team invite / remove events"));
    expect(rows(root).filter((r) => !r.querySelector(".ph-alarm"))).toHaveLength(3);
  });
});

describe("Past results footer", () => {
  const link = (root, tab) => root.querySelector(`.pd-reports [data-pd-see-more="${tab}"]`);
  const modal = () => document.getElementById("test-modal-slot");
  // History feeds both the quick actions and past results; its chips landing means it has loaded.
  const historyLoaded = (root) => vi.waitFor(() => expect(root.querySelectorAll(".pd-qa .pd-chip").length).toBeGreaterThan(1));

  it("keeps outcomes off the page; its Outcomes link opens all of them in the modal", async () => {
    dash.historyResult = history({
      outcomes: [1, 2, 3, 4].map((n) => ({ session_id: `o${n}`, title: `Outcome ${n}`, text: `First sentence ${n}. And then a long tail.`, at_ms: Date.now() - n * 60_000, repo_cwd: "C:/Projects/conductor" })),
    });
    const root = await mount({ kind: "project", id: "p1" });
    await historyLoaded(root);
    expect(root.querySelector(".pd-out")).toBeNull();

    link(root, "outcomes").click();
    expect(modal().querySelector("h3").textContent).toBe("Past results");
    expect(modal().querySelector(".pd-rtab.on").textContent).toBe("Outcomes");
    expect(modal().querySelectorAll(".pd-out")).toHaveLength(4);
    expect(modal().querySelector(".pd-out p").textContent).toBe("First sentence 1. And then a long tail.");
    modal().querySelector(".btn-primary").click();
    expect(modal().querySelector(".pd-modal")).toBeNull();
  });

  it("says Loading in the modal while history is still on its way, never a false empty state", async () => {
    let release;
    dash.historyResult = new Promise((resolve) => {
      release = () => resolve(history({
        outcomes: [{ session_id: "o1", title: "Outcome 1", text: "Done.", at_ms: Date.now(), repo_cwd: "C:/Projects/conductor" }],
      }));
    });
    const root = await mount({ kind: "project", id: "p1" });
    link(root, "outcomes").click();
    expect(modal().querySelector(".pd-mbody").textContent).toContain("Loading...");
    expect(modal().querySelector(".pd-mbody").textContent).not.toContain("No finished chats yet");

    release();
    await vi.waitFor(() => expect(modal().querySelectorAll(".pd-out")).toHaveLength(1));
  });

  it("says it could not load when history fails, instead of Loading forever", async () => {
    let fail;
    dash.historyResult = new Promise((_, reject) => { fail = () => reject(new Error("history down")); });
    const root = await mount({ kind: "project", id: "p1" });
    link(root, "outcomes").click();
    expect(modal().querySelector(".pd-mbody").textContent).toContain("Loading...");

    fail();
    await vi.waitFor(() => expect(modal().querySelector(".pd-mbody").textContent).toContain("Could not load past results"));
  });

  it("the Gallery link loads every image into the open modal, and its Files tab dims a missing file", async () => {
    dash.historyResult = history({
      gallery: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: `img${n}`, session_id: "s", title: `Shot ${n}`, at_ms: Date.now(), repo_cwd: "C:/Projects/conductor" })),
    });
    const root = await mount({ kind: "project", id: "p1" });
    await historyLoaded(root);
    link(root, "gallery").click();
    // Images keep arriving while the modal is open; it redraws on each paint.
    await vi.waitFor(() => expect(modal().querySelectorAll(".pd-shot img")).toHaveLength(7));

    [...modal().querySelectorAll(".pd-rtab")].find((b) => b.textContent === "Files").click();
    await vi.waitFor(() => expect(modal().querySelectorAll(".pd-row")).toHaveLength(2));
    expect([...modal().querySelectorAll(".pd-row")].map((r) => r.classList.contains("is-dim"))).toEqual([false, true]);
  });
});

describe("quick-action chips", () => {
  const chips = (root) => [...root.querySelectorAll(".pd-qa .pd-chip")].map((c) => c.textContent.trim());

  it("New chat leads the row and starts a chat with no message; the row scrolls, so it has no arrows", async () => {
    dash.snapshot = projectSnapshot({ pinned_actions: ["/a", "/b", "/c", "/d", "/e", "/f", "/g", "/h", "/i"] });
    const root = await mount({ kind: "project", id: "p1" });
    expect(chips(root)[0]).toBe("+ New chat");
    expect(root.querySelector("[data-pd-qa-dir]")).toBeNull();

    state.launchNewChatCallback = vi.fn();
    resolveNewChatConfig.mockResolvedValueOnce({ model: "m" });
    root.querySelector("[data-pd-new-chat]").click();
    await vi.waitFor(() => expect(state.launchNewChatCallback).toHaveBeenCalledWith(
      { path: "C:/Projects/conductor", name: "conductor" }, { model: "m" }));
  });

  it("shows the pinned list when there is one, never offers /close, and a chip starts a draft with its command typed in", async () => {
    dash.snapshot = projectSnapshot({ pinned_actions: ["/close", "/pickup", "/close now", "/audit"] });
    dash.historyResult = history({ quick_actions: [{ command: "/other", count: 1 }] });
    const root = await mount({ kind: "project", id: "p1" });
    await vi.waitFor(() => expect(chips(root)).toEqual(["+ New chat", "/pickup", "/audit"]));

    state.launchNewChatCallback = vi.fn();
    resolveNewChatConfig.mockResolvedValueOnce({ model: "m" });
    root.querySelectorAll(".pd-qa .pd-chip")[1].click();
    await vi.waitFor(() => expect(state.launchNewChatCallback).toHaveBeenCalledWith(
      { path: "C:/Projects/conductor", name: "conductor" }, { model: "m", draftText: "/pickup " }));
  });

  it("without a pinned list falls back to the most-used commands, minus /close", async () => {
    dash.historyResult = history({ quick_actions: [{ command: "/close", count: 99 }, { command: "/pushnbump", count: 9 }] });
    const root = await mount({ kind: "project", id: "p1" });
    await vi.waitFor(() => expect(chips(root)).toEqual(["+ New chat", "/pushnbump"]));
  });

  it("the kebab holds the project's own config and the open-in actions; the header carries only back and the kebab", async () => {
    dash.snapshot = projectSnapshot({ pinned_actions: ["/pickup"] });
    const root = await mount({ kind: "project", id: "p1" });
    expect([...root.querySelectorAll(".pd-head .pd-ib")].map((b) => b.title)).toEqual(["Back", "More"]);
    expect(chips(root)).toEqual(["+ New chat", "/pickup"]);
    root.querySelector("[data-pd-kebab]").click();
    await vi.waitFor(() => expect(document.querySelectorAll(".smore-item").length).toBeGreaterThan(0));
    const items = [...document.querySelectorAll(".smore-item")].map((b) => b.textContent.trim());
    expect(items).toEqual([
      "Rename project...", "Character...", "Folder mapping...", "Dashboard cards...",
      "Open in VS Code", "Open a terminal here", "Show in Explorer",
    ]);
  });
});

describe("custom card auto-refresh", () => {
  const refreshed = () => invoke.mock.calls.filter(([cmd]) => cmd === "dashboard_card_refresh").map(([, a]) => a.id);
  const result = (agoMin) => ({ fetched_at_ms: Date.now() - agoMin * 60_000, stats: [], rows: [], error: null });

  it("fetches a card that was never fetched or is past its interval, and leaves fresh and disabled ones alone", async () => {
    dash.snapshot = projectSnapshot({ cards: [
      cardView("never", "Never", { kind: "stats", items: [] }, null),
      cardView("stale", "Stale", { kind: "stats", items: [] }, result(20)),
      cardView("fresh", "Fresh", { kind: "stats", items: [] }, result(2)),
      cardView("short", "Short interval", { kind: "stats", items: [] }, result(2), true, { refresh_secs: 60 }),
      cardView("off", "Disabled", { kind: "stats", items: [] }, null, false),
    ] });
    invoke.mockClear();
    await mount({ kind: "project", id: "p1" });
    await vi.waitFor(() => expect(refreshed()).toEqual(["never", "stale", "short"]));
  });
});
