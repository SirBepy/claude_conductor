// @vitest-environment jsdom
//
// A mounted dashboard rendered from fixture snapshots: every section, the
// empty/hidden rules, the group repo filter, custom cards, and the
// snapshot-first / history-after load order. The tighter cards (tabs, paging,
// quick-action track, card extras) are in projects-tab-dashboard-cards.test.mjs.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { groupSnapshot, history, projectSnapshot, ZIRTUE_REPOS } from "./helpers/projects-tab-fixtures.mjs";

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

const { mountDashboard } = await import("../src/views/sessions/projects-tab/dashboard.ts");

const deps = () => ({ pane: document.body, flipToChats: vi.fn(), reloadList: vi.fn(), deselect: vi.fn() });
const cardIds = (root) => [...root.querySelectorAll("[data-pd-card]")].map((c) => c.dataset.pdCard);

async function mount(ref) {
  const d = deps();
  const h = mountDashboard(ref, d);
  document.body.appendChild(h.root);
  await vi.waitFor(() => expect(h.root.querySelector(".pd-head")).not.toBeNull());
  return { h, root: h.root, d };
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
    expect(root.querySelector(".pd-fab").getAttribute("aria-label")).toBe("New chat");
    await vi.waitFor(() => expect(root.querySelector('[data-pd-card="reports"] .pd-out')).not.toBeNull());
    expect(cardIds(root)).toEqual(["needs_you", "your_todos", "chats", "next_up", "ship", "running", "reports"]);
    expect(root.querySelector('[data-pd-card="needs_you"]').textContent).toContain("Dashboard brainstorm");
    expect(root.querySelector('[data-pd-card="next_up"] .ph-star')).not.toBeNull();
    expect(root.querySelector('[data-pd-card="next_up"]').textContent).toContain("#1264 Hyperfocus the mobile todos");
    expect(root.querySelector('[data-pd-card="ship"]').textContent).toContain("2 commits");
    // Running is servers only: the repo's other live chats are already in the Chats card.
    expect(root.querySelector('[data-pd-card="running"]').textContent).not.toContain("chats active in this repo");
    expect(root.querySelector('[data-pd-card="running"]').textContent).not.toContain("holding commit on chat-renderer.ts");
  });

  it("hides Your todos entirely when there are none, and shows quiet empty states elsewhere", async () => {
    snapshot = projectSnapshot({ your_todos: [], needs_you: [], plan: [], scheduled: [], servers: [], peers_active: 0, last_channel_message: null });
    const { root } = await mount({ kind: "project", id: "p1" });
    expect(root.querySelector('[data-pd-card="your_todos"]')).toBeNull();
    expect(root.querySelector('[data-pd-card="needs_you"]').textContent).toContain("Nothing waiting");
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

  it("rolls a repo's drafts into one row past two, keeping questions and a small repo's drafts as rows", async () => {
    const draft = (n, repo) => ({ kind: "draft", title: `d${n}`, detail: "", session_id: null, draft_id: `id${n}`, repo_cwd: repo, at_ms: n });
    snapshot = projectSnapshot({
      needs_you: [
        { kind: "question", title: "Asking", detail: "", session_id: "s1", draft_id: null, repo_cwd: "C:/p1", at_ms: 9 },
        draft(1, "C:/p1"), draft(2, "C:/p1"), draft(3, "C:/p1"), draft(4, "C:/p1"),
        draft(5, "C:/p2"),
      ],
    });
    const { root } = await mount({ kind: "project", id: "p1" });
    const text = [...root.querySelectorAll('[data-pd-card="needs_you"] .pd-row')].map((r) => r.textContent.trim());
    expect(text).toHaveLength(3);
    expect(text.some((t) => t.includes("Asking"))).toBe(true);
    expect(text.some((t) => t.includes("4 drafts not sent yet"))).toBe(true);
    expect(text.some((t) => t.includes("Draft not sent yet: d5"))).toBe(true);
  });

  it("drops a card whose builtin id is hidden", async () => {
    snapshot = projectSnapshot({ hidden_builtins: ["ship", "reports"] });
    const { root } = await mount({ kind: "project", id: "p1" });
    expect(root.querySelector('[data-pd-card="ship"]')).toBeNull();
    expect(root.querySelector('[data-pd-card="reports"]')).toBeNull();
    expect(root.querySelector('[data-pd-card="chats"]')).not.toBeNull();
  });

  it("hiding quick_actions removes the whole chip row", async () => {
    snapshot = projectSnapshot({ hidden_builtins: ["quick_actions"] });
    const { root } = await mount({ kind: "project", id: "p1" });
    expect(root.querySelector(".pd-qa")).toBeNull();
  });

  it("paints the snapshot first, then fills quick actions and reports once history lands", async () => {
    let release;
    historyGate = new Promise((r) => { release = r; });
    const { root } = await mount({ kind: "project", id: "p1" });

    expect(root.querySelector('[data-pd-card="needs_you"]')).not.toBeNull();
    expect(root.querySelector(".pd-qa")).toBeNull();
    expect(root.querySelector('[data-pd-card="reports"]').textContent).toContain("Loading...");

    release();
    await vi.waitFor(() => expect(root.querySelectorAll(".pd-qa .pd-chip")).toHaveLength(2));
    expect(root.querySelector(".pd-qa .pd-chip").textContent).toContain("/pushnbump");
    expect(root.querySelector('[data-pd-card="reports"] .pd-out b').textContent).toBe("Phone question sheet peek");
    expect(calls.map((c) => c.cmd).indexOf("dashboard_snapshot")).toBeLessThan(calls.map((c) => c.cmd).indexOf("dashboard_history"));
  });

  it("Reports tabs: gallery lazy-loads images one at a time, files dim a missing file", async () => {
    const { root } = await mount({ kind: "project", id: "p1" });
    await vi.waitFor(() => expect(root.querySelector('[data-pd-card="reports"] .pd-out')).not.toBeNull());

    [...root.querySelectorAll(".pd-rtab")].find((b) => b.textContent === "Gallery").click();
    await vi.waitFor(() => expect(root.querySelector(".pd-shot img")).not.toBeNull());
    expect(calls.filter((c) => c.cmd === "dashboard_gallery_image").map((c) => c.args)).toEqual([{ id: "img1" }]);

    [...root.querySelectorAll(".pd-rtab")].find((b) => b.textContent === "Files").click();
    const files = [...root.querySelectorAll('[data-pd-card="reports"] .pd-row')];
    expect(files).toHaveLength(2);
    expect(files[0].classList.contains("is-dim")).toBe(false);
    expect(files[1].classList.contains("is-dim")).toBe(true);
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

  it("shows repo chips, repo tags on rows, and one ship row per repo", async () => {
    snapshot = groupSnapshot();
    const { root } = await mount(ref);
    expect(root.querySelector(".ph-briefcase")).not.toBeNull();
    expect([...root.querySelectorAll(".pd-repo-chip")].map((c) => c.textContent.trim())).toEqual(["All", ...ZIRTUE_REPOS.map((r) => r.name)]);
    expect(root.querySelector('[data-pd-card="needs_you"] .pd-repo').textContent).toBe("zng-app");
    expect(root.querySelectorAll('[data-pd-card="ship"] .pd-row')).toHaveLength(ZIRTUE_REPOS.length);
    expect(root.querySelector('[data-pd-card="ship"] .pd-tbl')).toBeNull();
  });

  it("a repo chip narrows every section, and All restores them", async () => {
    snapshot = groupSnapshot();
    const { root } = await mount(ref);
    expect(root.querySelectorAll('[data-pd-card="chats"] .pd-row')).toHaveLength(2);

    [...root.querySelectorAll(".pd-repo-chip")].find((c) => c.textContent.trim() === "zng-biller").click();
    await vi.waitFor(() => expect(root.querySelectorAll('[data-pd-card="chats"] .pd-row')).toHaveLength(1));
    expect(root.querySelector('[data-pd-card="chats"] .pd-t').textContent).toBe("ACH retry backoff");
    expect(root.querySelector('[data-pd-card="needs_you"]').textContent).toContain("Nothing waiting");
    // one repo left: the per-repo rows give way to the single-repo detail view
    expect(root.querySelector('[data-pd-card="ship"] .pd-kv')).not.toBeNull();
    expect(root.querySelector('[data-pd-card="ship"]').textContent).toContain("1 commit");
    expect(root.querySelector(".pd-repo-chip.on").textContent.trim()).toBe("zng-biller");

    [...root.querySelectorAll(".pd-repo-chip")][0].click();
    await vi.waitFor(() => expect(root.querySelectorAll('[data-pd-card="chats"] .pd-row')).toHaveLength(2));
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
