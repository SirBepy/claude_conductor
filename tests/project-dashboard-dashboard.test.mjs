// @vitest-environment jsdom
//
// A mounted dashboard rendered from fixture snapshots: every section, the
// empty/hidden rules, group dashboards, custom cards, and the
// snapshot-first / history-after load order. The tighter cards (tabs, paging,
// quick-action track, card extras) are in project-dashboard-dashboard-cards.test.mjs.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { groupSnapshot, history, projectSnapshot, ZIRTUE_REPOS } from "./helpers/project-dashboard-fixtures.mjs";

globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);

const calls = [];
let snapshot = projectSnapshot();
let historyGate = null;
let historyResult = history();
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn(async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "dashboard_snapshot") return snapshot;
    if (cmd === "dashboard_history") { if (historyGate) await historyGate; return historyResult; }
    if (cmd === "dashboard_gallery_image") return "data:image/png;base64,AAAA";
    if (cmd === "dashboard_card_refresh") return { fetched_at_ms: Date.now(), stats: [{ label: "Today", value: "9h" }], rows: [], error: null };
    return null;
  }),
}));

const listeners = new Map();
vi.mock("../src/shared/transport.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    isRemote: () => false,
    getTransport: () => ({
      listen: async (name, cb) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(cb);
        return () => listeners.get(name)?.delete(cb);
      },
    }),
  };
});
vi.mock("../src/views/sessions/active-session.ts", () => ({ dismountActivePane: vi.fn(), selectSession: vi.fn(async () => {}) }));
vi.mock("../src/views/sessions/model-effort-modal.ts", () => ({ openModelEffortModal: vi.fn() }));

const { mountDashboard } = await import("../src/views/sessions/project-dashboard/dashboard.ts");

const deps = () => ({ mode: "page", pane: document.body, leave: vi.fn(), back: vi.fn(), deselect: vi.fn() });
const cardIds = (root) => [...root.querySelectorAll("[data-pd-card]")].map((c) => c.dataset.pdCard);

async function mount(ref) {
  const d = deps();
  const h = mountDashboard(ref, d);
  // The page puts the chip row under the dashboard; one wrapper lets a test query both.
  const wrap = document.createElement("div");
  wrap.append(h.root, h.chips);
  document.body.appendChild(wrap);
  await vi.waitFor(() => expect(h.root.querySelector(".pd-head")).not.toBeNull());
  return { h, root: wrap, d };
}

beforeEach(() => {
  document.body.innerHTML = "";
  calls.length = 0;
  listeners.clear();
  snapshot = projectSnapshot();
  historyGate = null;
  historyResult = history();
});

describe("single project", () => {
  it("paints header, branch line and every built-in section", async () => {
    const { root } = await mount({ kind: "project", id: "p1" });
    expect(root.querySelector(".pd-head h3").textContent).toBe("claude_usage_in_taskbar");
    expect(root.querySelector(".pd-branch").textContent).toBe("master ↑2");
    // New chat leads the chip row; there is no separate button or FAB for it.
    expect(root.querySelector(".pd-qa .pd-chip").textContent.trim()).toBe("+ New chat");
    expect(root.querySelector(".pd-fab")).toBeNull();
    // Past results' links lead, then Chats; Running closes the page. Unmeasured
    // (jsdom has no layout), the half-width cards alternate columns.
    expect(cardIds(root)).toEqual(["reports", "chats", "your_todos", "next_up", "usage", "ship", "running"]);
    expect(root.querySelector(".pd-reports").dataset.pdCard).toBe("reports");
    expect(root.querySelector('[data-pd-card="reports"] .pd-out')).toBeNull();
    expect(root.querySelector('[data-pd-card="next_up"] .ph-star')).not.toBeNull();
    expect(root.querySelector('[data-pd-card="next_up"]').textContent).toContain("#1264 Hyperfocus the mobile todos");
    expect(root.querySelector('[data-pd-card="ship"]').textContent).toContain("2 commits");
    // Running is servers only: the repo's other live chats are already in the Chats card.
    expect(root.querySelector('[data-pd-card="running"]').textContent).not.toContain("chats active in this repo");
    expect(root.querySelector('[data-pd-card="running"]').textContent).not.toContain("holding commit on chat-renderer.ts");
  });

  it("hides Your todos entirely when there are none, and shows quiet empty states elsewhere", async () => {
    snapshot = projectSnapshot({ your_todos: [], chats_running: [], chats_recent: [], plan: [], scheduled: [], servers: [] });
    const { root } = await mount({ kind: "project", id: "p1" });
    expect(root.querySelector('[data-pd-card="your_todos"]')).toBeNull();
    expect(root.querySelector('[data-pd-card="chats"]').textContent).toContain("No chats yet");
    expect(root.querySelector('[data-pd-card="next_up"]').textContent).toContain("Nothing queued");
    expect(root.querySelector('[data-pd-card="running"]').textContent).toContain("Nothing running");
  });

  it("only a chat waiting on a question gets the red dot; an idle your-turn chat stays neutral", async () => {
    const row = (session_id, status) => ({ session_id, title: session_id, status, repo_cwd: "C:/p1", at_ms: 0 });
    snapshot = projectSnapshot({ chats_running: [row("asking", "question"), row("idle", "your_turn")] });
    const { root } = await mount({ kind: "project", id: "p1" });
    const dotFor = (title) => [...root.querySelectorAll('[data-pd-card="chats"] .pd-row')]
      .find((r) => r.textContent.includes(title)).querySelector(".pd-dot");
    expect(dotFor("asking").classList.contains("q")).toBe(true);
    expect(dotFor("idle").classList.contains("q")).toBe(false);
    // The asking chat's title reads red too; the idle one's stays plain.
    expect(dotFor("asking").parentElement.querySelector(".pd-ask")).not.toBeNull();
    expect(dotFor("idle").parentElement.querySelector(".pd-ask")).toBeNull();
  });

  it("Running shows how many servers run beside its title, and no number when none do", async () => {
    const { root } = await mount({ kind: "project", id: "p1" });
    expect(root.querySelector('[data-pd-card="running"] .pd-h .pd-count').textContent).toBe("1");
    snapshot = projectSnapshot({ servers: [] });
    const again = await mount({ kind: "project", id: "p1" });
    expect(again.root.querySelector('[data-pd-card="running"] .pd-count')).toBeNull();
  });

  it("drops a card whose builtin id is hidden", async () => {
    snapshot = projectSnapshot({ hidden_builtins: ["ship", "reports"] });
    const { root } = await mount({ kind: "project", id: "p1" });
    expect(root.querySelector('[data-pd-card="ship"]')).toBeNull();
    expect(root.querySelector('[data-pd-card="reports"]')).toBeNull();
    expect(root.querySelector('[data-pd-card="chats"]')).not.toBeNull();
  });

  it("hiding quick_actions drops the commands but keeps New chat, the page's only way to start one", async () => {
    snapshot = projectSnapshot({ hidden_builtins: ["quick_actions"], pinned_actions: ["/pickup"] });
    const { root } = await mount({ kind: "project", id: "p1" });
    expect([...root.querySelectorAll(".pd-qa .pd-chip")].map((c) => c.textContent.trim())).toEqual(["+ New chat"]);
  });

  it("paints the snapshot first, then fills quick actions and reports once history lands", async () => {
    let release;
    historyGate = new Promise((r) => { release = r; });
    const { root } = await mount({ kind: "project", id: "p1" });

    expect(root.querySelector('[data-pd-card="chats"]')).not.toBeNull();
    expect([...root.querySelectorAll(".pd-qa .pd-chip")].map((c) => c.textContent.trim())).toEqual(["+ New chat"]);
    expect(root.querySelector('[data-pd-card="reports"]')).not.toBeNull();

    release();
    await vi.waitFor(() => expect(root.querySelectorAll(".pd-qa .pd-chip")).toHaveLength(3));
    expect([...root.querySelectorAll(".pd-qa .pd-chip")].map((c) => c.textContent.trim())).toEqual(["+ New chat", "/pushnbump", "/pickup"]);
    expect(calls.map((c) => c.cmd).indexOf("dashboard_snapshot")).toBeLessThan(calls.map((c) => c.cmd).indexOf("dashboard_history"));
  });

  it("checking a todo writes done through dashboard_todo_set_state", async () => {
    const { root } = await mount({ kind: "project", id: "p1" });
    const box = root.querySelector(".pd-todo input");
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    expect(calls.find((c) => c.cmd === "dashboard_todo_set_state").args).toEqual({ projectId: "p1", id: "t1", next: "done" });
    await vi.waitFor(() => expect(root.querySelector(".pd-todo").classList.contains("is-done")).toBe(true));
  });
});

describe("group", () => {
  const ref = { kind: "group", id: "g1" };

  it("shows the repo count under the name, repo tags on rows, and one ship row per repo", async () => {
    snapshot = groupSnapshot();
    const { root } = await mount(ref);
    expect(root.querySelector(".ph-briefcase")).not.toBeNull();
    expect(root.querySelector(".pd-subline").textContent.trim()).toBe(`${ZIRTUE_REPOS.length} repos`);
    // Every section shows every repo; the tag says which one a row is from.
    expect([...root.querySelectorAll('[data-pd-card="chats"] .pd-repo')].map((t) => t.textContent).sort()).toEqual(["zng-admin", "zng-app", "zng-biller"]);
    expect(root.querySelectorAll('[data-pd-card="ship"] .pd-row')).toHaveLength(ZIRTUE_REPOS.length);
  });

  it("an unmeasured paint (no layout, as in a hidden pane) keeps the sections split across both columns", async () => {
    // jsdom lays nothing out, so every section measures 0 here: exactly the hidden-pane case.
    snapshot = groupSnapshot();
    const { root } = await mount(ref);
    const [left, right] = [...root.querySelectorAll(".pd-col")];
    expect(left.querySelectorAll("[data-pd-card]").length).toBeGreaterThan(0);
    expect(right.querySelectorAll("[data-pd-card]").length).toBeGreaterThan(0);
  });

  // The fixture cards were fetched up to an hour ago; a day-long interval keeps
  // the dashboard's own stale-card refresh from replacing what these assert.
  const settled = (snap) => { for (const v of snap.cards) v.config.refresh_secs = 86_400; return snap; };

  it("renders enabled custom cards (list and stats), hides a disabled one, shows an error line", async () => {
    snapshot = settled(groupSnapshot());
    const { root } = await mount(ref);
    expect(cardIds(root)).toContain("card:c1");
    expect(cardIds(root)).toContain("card:c2");
    expect(cardIds(root)).not.toContain("card:c3");
    expect(root.querySelector('[data-pd-card="card:c1"] .pd-row .pd-t').textContent).toBe("Retry failed ACH payouts");
    expect(root.querySelector('[data-pd-card="card:c1"] .pd-fetched').textContent).toBe("fetched 6m ago");
    expect(root.querySelector('[data-pd-card="card:c2"] .pd-kv').textContent).toContain("2h 10m");
    expect(root.querySelector('[data-pd-card="card:c4"] .pd-err').textContent).toBe("HTTP 401 from the tracker");
  });

  it("the refresh icon calls dashboard_card_refresh and repaints the new values", async () => {
    snapshot = settled(groupSnapshot());
    const { root } = await mount(ref);
    root.querySelector('[data-pd-card="card:c2"] button[title="Refresh"]').click();
    expect(calls.find((c) => c.cmd === "dashboard_card_refresh").args).toEqual({ id: "c2" });
    await vi.waitFor(() => expect(root.querySelector('[data-pd-card="card:c2"] .pd-kv').textContent).toContain("9h"));
  });
});

describe("live updates", () => {
  it("refetches the snapshot on a dashboard event and stops once the root leaves the DOM", async () => {
    const { h, root } = await mount({ kind: "project", id: "p1" });
    const n = () => calls.filter((c) => c.cmd === "dashboard_snapshot").length;
    const start = n();
    for (const cb of listeners.get("dashboard-changed") ?? []) cb({});
    await vi.waitFor(() => expect(n()).toBe(start + 1));

    root.remove();
    for (const cb of listeners.get("user-todos-changed") ?? []) cb({});
    await new Promise((r) => setTimeout(r, 600));
    expect(n()).toBe(start + 1);
    expect(listeners.get("user-todos-changed")?.size ?? 0).toBe(0);
    h.destroy();
  });
});
