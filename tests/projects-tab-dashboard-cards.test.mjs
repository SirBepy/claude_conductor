// @vitest-environment jsdom
//
// The dashboard's tighter cards: the Chats tabs and status groups, Next up
// summaries and paging, the compact Reports card with its See more modal, the
// one-line quick-action track, and the custom-card extras (progress bar,
// headline, run button).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { card as cardView, groupSnapshot, history, mixedChats, planItems, projectSnapshot } from "./helpers/projects-tab-fixtures.mjs";

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

const { mountDashboard } = await import("../src/views/sessions/projects-tab/dashboard.ts");
const { state } = await import("../src/views/sessions/state.ts");
const { openModelEffortModal } = await import("../src/views/sessions/model-effort-modal.ts");

async function mount(ref) {
  const h = mountDashboard(ref, { pane: document.body, flipToChats: vi.fn(), reloadList: vi.fn(), deselect: vi.fn() });
  document.body.appendChild(h.root);
  await vi.waitFor(() => expect(h.root.querySelector(".pd-head")).not.toBeNull());
  return h.root;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="test-modal-slot"></div>';
  snapshot = projectSnapshot();
  historyResult = history();
  vi.clearAllMocks();
});

describe("Chats card", () => {
  const rowsText = (root) => [...root.querySelectorAll('[data-pd-card="chats"] .pd-row .pd-t')].map((n) => n.textContent);
  const heads = (root) => [...root.querySelectorAll('[data-pd-card="chats"] .pd-sub')].map((n) => n.textContent);

  it("Current groups live chats under the sidebar's three words, empty groups omitted, 4 rows a page", async () => {
    snapshot = projectSnapshot({ chats_running: mixedChats() });
    const root = await mount({ kind: "project", id: "p1" });
    expect(root.querySelector('[data-pd-card="chats"] .pd-rtab.on').textContent).toBe("Current");
    expect(heads(root)).toEqual(["Input needed", "In progress"]);
    expect(rowsText(root)).toEqual(["ask-a", "work-a", "work-b", "wait-a"]);
    expect(root.querySelector('[data-pd-pager="chats"] .pd-pg-n').textContent).toBe("1/2");

    root.querySelector('[data-pd-pager="chats"] button[title="Next"]').click();
    await vi.waitFor(() => expect(rowsText(root)).toEqual(["done-a"]));
    expect(heads(root)).toEqual(["Done"]);
    expect(root.querySelector('[data-pd-pager="chats"] button[title="Next"]').disabled).toBe(true);
  });

  it("a short list shows no pager, and the Recent tab lists ended chats", async () => {
    snapshot = projectSnapshot({ chats_running: mixedChats().slice(0, 2) });
    const root = await mount({ kind: "project", id: "p1" });
    expect(root.querySelector('[data-pd-pager="chats"]')).toBeNull();
    [...root.querySelectorAll('[data-pd-card="chats"] .pd-rtab')].find((b) => b.textContent === "Recent").click();
    await vi.waitFor(() => expect(rowsText(root)).toEqual(["Phone question sheet peek"]));
    expect(heads(root)).toEqual([]);
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

describe("Reports card", () => {
  // Which shape shows (rows that fit, or tiles) depends on the card's height, which
  // jsdom never lays out; projects-tab.view.spec.ts checks that half in a browser.
  it("carries every outcome as a row and as a tile, and See more opens the full tab in the modal", async () => {
    historyResult = history({
      outcomes: [1, 2, 3, 4].map((n) => ({ session_id: `o${n}`, title: `Outcome ${n}`, text: `First sentence ${n}. And then a long tail.`, at_ms: Date.now() - n * 60_000, repo_cwd: "C:/Projects/conductor" })),
    });
    const root = await mount({ kind: "project", id: "p1" });
    const reports = () => root.querySelector('[data-pd-card="reports"]');
    await vi.waitFor(() => expect(reports().querySelectorAll(".pd-fit .pd-row")).toHaveLength(4));
    expect(reports().querySelector(".pd-row .pd-muted").textContent).toBe("First sentence 1. And then a long tail.");
    expect(reports().querySelectorAll(".pd-tiles .pd-out")).toHaveLength(4);

    reports().querySelector("[data-pd-see-more]").click();
    const modal = document.getElementById("test-modal-slot");
    expect(modal.querySelector("h3").textContent).toContain("Outcomes");
    expect(modal.querySelectorAll(".pd-out")).toHaveLength(4);
    modal.querySelector(".btn-primary").click();
    expect(modal.querySelector(".pd-modal")).toBeNull();
  });

  it("the Gallery tab carries six thumbnails, and the modal shows them all", async () => {
    historyResult = history({
      gallery: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: `img${n}`, session_id: "s", title: `Shot ${n}`, at_ms: Date.now(), repo_cwd: "C:/Projects/conductor" })),
    });
    const root = await mount({ kind: "project", id: "p1" });
    await vi.waitFor(() => expect(root.querySelector('[data-pd-card="reports"] .pd-row')).not.toBeNull());
    [...root.querySelectorAll('[data-pd-card="reports"] .pd-rtab')].find((b) => b.textContent === "Gallery").click();
    await vi.waitFor(() => expect(root.querySelectorAll('[data-pd-card="reports"] .pd-shot img')).toHaveLength(6));
    expect(root.querySelector('[data-pd-card="reports"] .pd-gal').classList.contains("compact")).toBe(true);

    root.querySelector("[data-pd-see-more]").click();
    const modal = document.getElementById("test-modal-slot");
    // Images keep arriving while the modal is open; it redraws on each paint.
    await vi.waitFor(() => expect(modal.querySelectorAll(".pd-shot img")).toHaveLength(7));
  });
});

describe("quick-action track", () => {
  const proto = HTMLElement.prototype;
  const saved = {};
  const CHIP = 80;
  const GAP = 6;

  // jsdom has no layout, so the measured widths the track pages by are stubbed:
  // 80px chips 6px apart, a 300px track, and a 400px row (track plus two arrows).
  function stubLayout() {
    const stub = (name, get) => {
      saved[name] = Object.getOwnPropertyDescriptor(proto, name);
      Object.defineProperty(proto, name, { configurable: true, get });
    };
    stub("offsetWidth", function () { return this.classList.contains("pd-chip") ? CHIP : 0; });
    stub("offsetLeft", function () { return this.classList.contains("pd-chip") ? [...this.parentElement.children].indexOf(this) * (CHIP + GAP) : 0; });
    stub("clientWidth", function () { return this.classList.contains("pd-qa") ? 400 : this.classList.contains("pd-qa-track") ? 300 : 0; });
  }
  // clientWidth lives on Element.prototype, so its "saved" descriptor is undefined and restoring means deleting the shadow.
  afterEach(() => {
    for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(proto, k, d); else delete proto[k]; delete saved[k]; }
  });

  const PINNED = ["/a", "/b", "/c", "/d", "/e", "/f", "/g", "/h", "/i"];
  const shift = (root) => root.querySelector(".pd-qa-strip").style.transform;
  const btn = (root, dir) => root.querySelector(`[data-pd-qa-dir="${dir}"]`);

  it("pages by the chips that fully fit: right slides forward, left slides back, arrows disable at the ends", async () => {
    stubLayout();
    snapshot = projectSnapshot({ pinned_actions: PINNED });
    const root = await mount({ kind: "project", id: "p1" });
    expect(root.querySelector(".pd-qa").classList.contains("is-fit")).toBe(false);
    expect(shift(root)).toBe("translateX(0px)");
    expect(btn(root, -1).disabled).toBe(true);
    expect(btn(root, 1).disabled).toBe(false);

    btn(root, 1).click(); // 3 chips fit in 300px, so the next page starts at the 4th
    expect(shift(root)).toBe(`translateX(-${3 * (CHIP + GAP)}px)`);
    expect(btn(root, -1).disabled).toBe(false);

    btn(root, 1).click();
    btn(root, 1).click();
    expect(btn(root, 1).disabled).toBe(true);
    const end = shift(root);

    btn(root, -1).click();
    expect(shift(root)).not.toBe(end);
    for (let i = 0; i < 4; i++) btn(root, -1).click();
    expect(shift(root)).toBe("translateX(0px)");
    expect(btn(root, -1).disabled).toBe(true);
  });

  it("hides the arrows when every chip fits", async () => {
    stubLayout();
    snapshot = projectSnapshot({ pinned_actions: ["/a", "/b"] });
    const root = await mount({ kind: "project", id: "p1" });
    expect(root.querySelector(".pd-qa").classList.contains("is-fit")).toBe(true);
    expect(root.querySelectorAll(".pd-qa-strip .pd-chip")).toHaveLength(2);
  });

  it("shows the pinned list when there is one, never offers /close, and a chip starts a chat with its command", async () => {
    snapshot = projectSnapshot({ pinned_actions: ["/close", "/pickup", "/close now", "/audit"] });
    historyResult = history({ quick_actions: [{ command: "/other", count: 1 }] });
    const root = await mount({ kind: "project", id: "p1" });
    await vi.waitFor(() => expect(root.querySelectorAll(".pd-qa .pd-chip")).toHaveLength(2));
    expect([...root.querySelectorAll(".pd-qa .pd-chip")].map((c) => c.textContent.trim())).toEqual(["/pickup", "/audit"]);

    state.launchNewChatCallback = vi.fn();
    openModelEffortModal.mockResolvedValueOnce({ model: "m" });
    root.querySelector(".pd-qa .pd-chip").click();
    await vi.waitFor(() => expect(state.launchNewChatCallback).toHaveBeenCalledWith(
      { path: "C:/Projects/conductor", name: "conductor" }, { model: "m", initialMessage: "/pickup" }));
  });

  it("without a pinned list falls back to the most-used commands, minus /close", async () => {
    historyResult = history({ quick_actions: [{ command: "/close", count: 99 }, { command: "/pushnbump", count: 9 }] });
    const root = await mount({ kind: "project", id: "p1" });
    await vi.waitFor(() => expect(root.querySelectorAll(".pd-qa .pd-chip")).toHaveLength(1));
    expect(root.querySelector(".pd-qa .pd-chip").textContent.trim()).toBe("/pushnbump");
  });

  it("open-in actions are three icon-only buttons in the header, not chips", async () => {
    snapshot = projectSnapshot({ pinned_actions: ["/pickup"] });
    const root = await mount({ kind: "project", id: "p1" });
    const open = [...root.querySelectorAll(".pd-head [data-pd-open]")];
    expect(open.map((b) => b.dataset.pdOpen)).toEqual(["vscode", "terminal", "explorer"]);
    expect(open.every((b) => b.textContent.trim() === "" && b.title)).toBe(true);
    expect(root.querySelector(".pd-qa [data-pd-open]")).toBeNull();
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

  it("the action button starts a chat in the chosen repo with its command", async () => {
    snapshot = groupSnapshot();
    const root = await mount({ kind: "group", id: "g1" });
    const button = root.querySelector('[data-pd-card="card:c5"] [data-pd-action]');
    expect(button.textContent).toBe("Run /shortcut-priorities");
    expect(root.querySelector('[data-pd-card="card:c5"] .pd-headline').textContent).toContain("12 updates since /shortcut-priorities ran 2d ago");

    [...root.querySelectorAll(".pd-repo-chip")].find((c) => c.textContent.trim() === "zng-biller").click();
    state.launchNewChatCallback = vi.fn();
    openModelEffortModal.mockResolvedValueOnce({ model: "m" });
    root.querySelector('[data-pd-card="card:c5"] [data-pd-action]').click();
    await vi.waitFor(() => expect(state.launchNewChatCallback).toHaveBeenCalledWith(
      { path: "C:/Projects/zng-biller", name: "zng-biller" }, { model: "m", initialMessage: "/shortcut-priorities" }));
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
