// @vitest-environment jsdom
//
// The dashboard's tighter cards: the Chats list (live chats in status order,
// then the most recently closed), Next up summaries and paging, the Past
// results footer and its modal, the quick-action chip row, and the
// custom-card extras (progress bar, headline, run button).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { card as cardView, groupSnapshot, history, mixedChats, planItems, projectSnapshot } from "./helpers/project-dashboard-fixtures.mjs";

globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);

let snapshot = projectSnapshot();
let historyResult = history();
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn(async (cmd) => {
    if (cmd === "dashboard_snapshot") return snapshot;
    if (cmd === "dashboard_history") return historyResult;
    if (cmd === "dashboard_gallery_image") return "data:image/png;base64,AAAA";
    return null;
  }),
}));
vi.mock("../src/shared/transport.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isRemote: () => false, getTransport: () => ({ listen: async () => () => {} }) };
});
vi.mock("../src/views/sessions/active-session.ts", () => ({ dismountActivePane: vi.fn(), selectSession: vi.fn(async () => {}) }));
vi.mock("../src/views/sessions/model-effort-modal.ts", () => ({ openModelEffortModal: vi.fn() }));
// The real host morphs between cards on timers; the tests only need the card in a slot.
vi.mock("../src/shared/modal.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    modalCardSlot: () => document.getElementById("test-modal-slot"),
    presentHostCard: vi.fn(async (fn) => fn()),
    closeHostCard: vi.fn(() => { document.getElementById("test-modal-slot").replaceChildren(); }),
    setBackdropCancel: vi.fn(),
  };
});

const { mountDashboard } = await import("../src/views/sessions/project-dashboard/dashboard.ts");
const { state } = await import("../src/views/sessions/state.ts");
const { openModelEffortModal } = await import("../src/views/sessions/model-effort-modal.ts");
const { invoke } = await import("../src/shared/ipc.ts");

async function mount(ref) {
  const h = mountDashboard(ref, { mode: "page", pane: document.body, leave: vi.fn(), back: vi.fn(), deselect: vi.fn() });
  // The page puts the chip row under the dashboard; one wrapper lets a test query both.
  const wrap = document.createElement("div");
  wrap.append(h.root, h.chips);
  document.body.appendChild(wrap);
  await vi.waitFor(() => expect(h.root.querySelector(".pd-head")).not.toBeNull());
  return wrap;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="test-modal-slot"></div>';
  snapshot = projectSnapshot();
  historyResult = history();
  vi.clearAllMocks();
});

describe("Chats card", () => {
  const rowsText = (root) => [...root.querySelectorAll('[data-pd-card="chats"] .pd-row .pd-t')].map((n) => n.textContent);
  const label = (root) => root.querySelector('[data-pd-card="chats"] [data-pd-past-label]');
  const recent = (n) => Array.from({ length: n }, (_, i) => ({ session_id: `old-${i}`, title: `old-${i}`, status: "ended", repo_cwd: "C:/Projects/conductor", at_ms: Date.now() - (i + 1) * 60_000 }));

  it("lists live chats in the sidebar's group order with no gap between groups, 4 a page, then the closed ones", async () => {
    snapshot = projectSnapshot({ chats_running: mixedChats() });
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
    snapshot = projectSnapshot({ chats_running: mixedChats().slice(0, 2), chats_recent: recent(5) });
    const root = await mount({ kind: "project", id: "p1" });
    expect(root.querySelector('[data-pd-pager="chats"]')).toBeNull();
    expect(rowsText(root)).toEqual(["ask-a", "work-a", "old-0", "old-1", "old-2"]);
    expect(root.querySelectorAll('[data-pd-card="chats"] .pd-t .pd-muted')).toHaveLength(3);
    expect(root.querySelector('[data-pd-card="chats"] .pd-rtab')).toBeNull();
    expect(root.querySelector('[data-pd-card="chats"] [data-pd-all-history]').title).toBe("History");
  });

  it("drops the Recently closed label when there are no live chats above it", async () => {
    snapshot = projectSnapshot({ chats_running: [], chats_recent: recent(2) });
    const root = await mount({ kind: "project", id: "p1" });
    expect(rowsText(root)).toEqual(["old-0", "old-1"]);
    expect(label(root)).toBeNull();
  });
});

describe("Next up", () => {
  const rows = (root) => [...root.querySelectorAll('[data-pd-card="next_up"] .pd-row')];

  it("shows the first three items cut to a headline with the full text as the tooltip, no subheadings", async () => {
    snapshot = projectSnapshot({ plan: planItems(), scheduled: [] });
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
    snapshot = projectSnapshot({
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
    historyResult = history({
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
    historyResult = new Promise((resolve) => {
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
    historyResult = new Promise((_, reject) => { fail = () => reject(new Error("history down")); });
    const root = await mount({ kind: "project", id: "p1" });
    link(root, "outcomes").click();
    expect(modal().querySelector(".pd-mbody").textContent).toContain("Loading...");

    fail();
    await vi.waitFor(() => expect(modal().querySelector(".pd-mbody").textContent).toContain("Could not load past results"));
  });

  it("the Gallery link loads every image into the open modal, and its Files tab dims a missing file", async () => {
    historyResult = history({
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
    snapshot = projectSnapshot({ pinned_actions: ["/a", "/b", "/c", "/d", "/e", "/f", "/g", "/h", "/i"] });
    const root = await mount({ kind: "project", id: "p1" });
    expect(chips(root)[0]).toBe("+ New chat");
    expect(root.querySelector("[data-pd-qa-dir]")).toBeNull();

    state.launchNewChatCallback = vi.fn();
    openModelEffortModal.mockResolvedValueOnce({ model: "m" });
    root.querySelector("[data-pd-new-chat]").click();
    await vi.waitFor(() => expect(state.launchNewChatCallback).toHaveBeenCalledWith(
      { path: "C:/Projects/conductor", name: "conductor" }, { model: "m" }));
  });

  it("shows the pinned list when there is one, never offers /close, and a chip starts a draft with its command typed in", async () => {
    snapshot = projectSnapshot({ pinned_actions: ["/close", "/pickup", "/close now", "/audit"] });
    historyResult = history({ quick_actions: [{ command: "/other", count: 1 }] });
    const root = await mount({ kind: "project", id: "p1" });
    await vi.waitFor(() => expect(chips(root)).toEqual(["+ New chat", "/pickup", "/audit"]));

    state.launchNewChatCallback = vi.fn();
    openModelEffortModal.mockResolvedValueOnce({ model: "m" });
    root.querySelectorAll(".pd-qa .pd-chip")[1].click();
    await vi.waitFor(() => expect(state.launchNewChatCallback).toHaveBeenCalledWith(
      { path: "C:/Projects/conductor", name: "conductor" }, { model: "m", draftText: "/pickup " }));
  });

  it("without a pinned list falls back to the most-used commands, minus /close", async () => {
    historyResult = history({ quick_actions: [{ command: "/close", count: 99 }, { command: "/pushnbump", count: 9 }] });
    const root = await mount({ kind: "project", id: "p1" });
    await vi.waitFor(() => expect(chips(root)).toEqual(["+ New chat", "/pushnbump"]));
  });

  it("the kebab holds the project's own config and the open-in actions; the header carries only back and the kebab", async () => {
    snapshot = projectSnapshot({ pinned_actions: ["/pickup"] });
    const root = await mount({ kind: "project", id: "p1" });
    expect([...root.querySelectorAll(".pd-head .pd-ib")].map((b) => b.title)).toEqual(["Back", "More"]);
    expect(chips(root)).toEqual(["+ New chat", "/pickup"]);
    root.querySelector("[data-pd-kebab]").click();
    const items = [...document.querySelectorAll(".smore-item")].map((b) => b.textContent.trim());
    expect(items).toEqual([
      "Rename project...", "Character...", "Project settings...", "Folder mapping...", "Dashboard cards...",
      "Open in VS Code", "Open a terminal here", "Show in Explorer",
    ]);
  });
});

describe("custom card extras", () => {
  it("renders the progress bar, the headline in its tone, and the run button", async () => {
    snapshot = groupSnapshot();
    const root = await mount({ kind: "group", id: "g1" });
    const ck = root.querySelector('[data-pd-card="card:c6"]');
    expect(ck.querySelector(".pd-prog-label").textContent).toBe("14h 30m of 20h this week");
    expect(ck.querySelector(".pd-prog-bar span").getAttribute("style")).toContain("72.5%");
    expect(ck.querySelector(".pd-prog").classList.contains("is-behind")).toBe(true);
    expect(ck.querySelector(".pd-hl-t").classList.contains("warn")).toBe(true);
    expect(ck.querySelector(".pd-hl-t").textContent).toBe("3 workdays not logged: Mon, Tue, Wed");
    expect(ck.querySelector(".pd-kv")).toBeNull();
    expect(ck.textContent).not.toContain("No values");
  });

  it("a card without extras renders as before, and an all-clear headline is muted success", async () => {
    snapshot = groupSnapshot();
    snapshot.cards.push(cardView("c7", "Clockify ok", { kind: "stats", items: [] },
      { fetched_at_ms: Date.now(), stats: [], rows: [], error: null, headline: "All logged", headline_tone: "good",
        progress: { value: 20, max: 20, label: "20h of 20h this week" } }));
    const root = await mount({ kind: "group", id: "g1" });
    expect(root.querySelector('[data-pd-card="card:c2"] .pd-prog')).toBeNull();
    expect(root.querySelector('[data-pd-card="card:c2"] [data-pd-action]')).toBeNull();
    expect(root.querySelector('[data-pd-card="card:c7"] .pd-hl-t').classList.contains("good")).toBe(true);
    expect(root.querySelector('[data-pd-card="card:c7"] .pd-prog').classList.contains("is-behind")).toBe(false);
  });

  it("an html card draws its own look in a sandboxed frame instead of the bar and headline, keeping its button", async () => {
    snapshot = groupSnapshot();
    const data = { _card: { headline: "All logged", progress: { value: 12, max: 20, label: "12h of 20h" } } };
    snapshot.cards.push({
      ...cardView("c9", "Clockify pie", { kind: "html", template: "<svg id=pie></svg>" },
        { fetched_at_ms: Date.now(), stats: [], rows: [], error: null, headline: "All logged", headline_tone: "good",
          progress: data._card.progress, data }),
    });
    snapshot.cards.at(-1).config.action = { label: "Log time", command: "/clockify-log" };
    const root = await mount({ kind: "group", id: "g1" });
    const ck = root.querySelector('[data-pd-card="card:c9"]');
    const frame = ck.querySelector("iframe.pd-html-frame");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.srcdoc).toContain("<svg id=pie></svg>");
    expect(frame.srcdoc).toContain('"label":"12h of 20h"');
    expect(ck.querySelector(".pd-prog")).toBeNull();
    expect(ck.querySelector(".pd-hl-t").textContent).toBe("");
    expect(ck.querySelector("[data-pd-action]").textContent).toBe("Log time");
  });

  it("the action button asks which repo, then starts a draft there with its command typed in", async () => {
    snapshot = groupSnapshot();
    const root = await mount({ kind: "group", id: "g1" });
    const button = root.querySelector('[data-pd-card="card:c5"] [data-pd-action]');
    expect(button.textContent).toBe("Run /shortcut-priorities");
    expect(root.querySelector('[data-pd-card="card:c5"] .pd-headline').textContent).toContain("12 updates since /shortcut-priorities ran 2d ago");

    state.launchNewChatCallback = vi.fn();
    openModelEffortModal.mockResolvedValueOnce({ model: "m" });
    root.querySelector('[data-pd-card="card:c5"] [data-pd-action]').click();
    const pick = () => [...document.querySelectorAll(".smore-item")].find((b) => b.textContent.trim() === "zng-biller");
    await vi.waitFor(() => expect(pick()).toBeTruthy());
    pick().click();
    await vi.waitFor(() => expect(state.launchNewChatCallback).toHaveBeenCalledWith(
      { path: "C:/Projects/zng-biller", name: "zng-biller" }, { model: "m", draftText: "/shortcut-priorities " }));
  });

  it("pages a long list card instead of showing every row", async () => {
    snapshot = groupSnapshot();
    snapshot.cards.push(cardView("c8", "Long list", { kind: "list", items_path: "a", label_path: "b", value_path: "c", link_path: null, limit: null },
      { fetched_at_ms: Date.now(), stats: [], error: null, rows: Array.from({ length: 6 }, (_, i) => ({ label: `row ${i + 1}`, value: "", link: null })) }));
    const root = await mount({ kind: "group", id: "g1" });
    const rows = () => [...root.querySelectorAll('[data-pd-card="card:c8"] .pd-row .pd-t')].map((n) => n.textContent);
    expect(rows()).toEqual(["row 1", "row 2", "row 3", "row 4"]);
    root.querySelector('[data-pd-pager="card:c8"] button[title="Next"]').click();
    await vi.waitFor(() => expect(rows()).toEqual(["row 5", "row 6"]));
  });
});

describe("custom card auto-refresh", () => {
  const refreshed = () => invoke.mock.calls.filter(([cmd]) => cmd === "dashboard_card_refresh").map(([, a]) => a.id);
  const result = (agoMin) => ({ fetched_at_ms: Date.now() - agoMin * 60_000, stats: [], rows: [], error: null });

  it("fetches a card that was never fetched or is past its interval, and leaves fresh and disabled ones alone", async () => {
    snapshot = projectSnapshot({ cards: [
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
