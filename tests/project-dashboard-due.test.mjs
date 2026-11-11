// @vitest-environment jsdom
//
// The Due card: the pure rules (visibility, labels, which ids "Do all due"
// hands over, the toggle) and the card mounted on the dashboard (counts only,
// the missed pill, the Backlog panel's highlight set, the message it sends).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { dash, mount, resetDashboard, state, resolveNewChatConfig } from "./helpers/project-dashboard-cards-setup.mjs";
import { projectSnapshot, groupRow, ZIRTUE_REPOS } from "./helpers/project-dashboard-fixtures.mjs";

const { mountDashboard } = await import("../src/views/sessions/project-dashboard/dashboard.ts");
const model = await import("../src/views/sessions/project-dashboard/due-model.ts");
const highlight = await import("../src/views/sessions/backlog-panel/due-highlight.ts");

const CWD = "C:/Projects/conductor";
const ids = (...n) => n.map((i) => ({ id: `pc-${i}`, repo_cwd: CWD }));
const day = (date, list) => ({ date, count: list.length, ids: list });
const DUE = {
  days: [day("2026-11-10", ids(1, 2)), day("2026-11-11", ids(3)), day("2026-11-12", []), day("2026-11-13", ids(4)), day("2026-11-14", [])],
  missed_ids: ids(8, 9),
};
const NONE = { days: [], missed_ids: [] };

describe("due model", () => {
  it("shows only when something is due in the window or missed", () => {
    expect(model.dueVisible(NONE)).toBe(false);
    expect(model.dueVisible({ days: DUE.days.map((d) => day(d.date, [])), missed_ids: [] })).toBe(false);
    expect(model.dueVisible({ days: [], missed_ids: ids(8) })).toBe(true);
    expect(model.dueVisible(DUE)).toBe(true);
    expect(model.dueTotal(DUE)).toBe(6);
  });

  it("labels today, then weekday and day number, without a timezone shift", () => {
    expect(model.dayLabel("2026-11-10", 0)).toBe("Today");
    expect(model.dayLabel("2026-11-12", 2)).toBe("Thu 12");
    expect(model.dayLabel("2026-11-01", 1)).toBe("Sun 1");
    expect(model.dayLabel("not a date", 1)).toBe("not a date");
  });

  it("hands over the missed ids plus today's, each once, and nothing else", () => {
    expect(model.doAllIds(DUE).map((d) => d.id)).toEqual(["pc-8", "pc-9", "pc-1", "pc-2"]);
    // The same todo listed as missed and as due today (same repo, spelled two ways) counts once.
    const twice = { days: [day("2026-11-10", [{ id: "pc-8", repo_cwd: "C:\\Projects\\Conductor\\" }])], missed_ids: ids(8) };
    expect(model.doAllIds(twice)).toHaveLength(1);
    expect(model.doAllMessage(DUE)).toBe("/auto-do-todos pc-8,pc-9,pc-1,pc-2");
    expect(model.doAllMessage({ days: DUE.days.map((d, i) => (i === 0 ? day(d.date, []) : d)), missed_ids: [] })).toBeNull();
  });

  const OTHER = "C:/Projects/other";
  const GROUP_DUE = {
    days: [day("2026-11-10", [{ id: "pc-1", repo_cwd: CWD }, { id: "pc-1", repo_cwd: OTHER }, { id: "ot-5", repo_cwd: OTHER }])],
    missed_ids: [{ id: "pc-8", repo_cwd: CWD }],
  };

  it("keeps an id that two repos share as two todos, so the count is right", () => {
    expect(model.doAllIds(GROUP_DUE)).toHaveLength(4);
    expect(model.doAllRepos(GROUP_DUE)).toEqual([{ cwd: CWD, count: 2 }, { cwd: OTHER, count: 2 }]);
  });

  it("hands one repo only its own ids", () => {
    expect(model.doAllMessage(GROUP_DUE, CWD)).toBe("/auto-do-todos pc-8,pc-1");
    expect(model.doAllMessage(GROUP_DUE, "C:\\Projects\\Other\\")).toBe("/auto-do-todos pc-1,ot-5");
    expect(model.doAllMessage(GROUP_DUE, "C:/Projects/none")).toBeNull();
  });

  it("keeps a selection only while its cell still exists", () => {
    expect(model.reconcileSelection(DUE, null)).toBeNull();
    expect(model.reconcileSelection(DUE, "missed")).toBe("missed");
    expect(model.reconcileSelection(NONE, "missed")).toBeNull();
    expect(model.reconcileSelection(DUE, "2026-11-12")).toBe("2026-11-12");
    expect(model.reconcileSelection(DUE, "2026-10-01")).toBeNull();
  });

  it("toggles: the same cell clears, another replaces", () => {
    expect(model.toggleSelection(null, "2026-11-11")).toBe("2026-11-11");
    expect(model.toggleSelection("2026-11-11", "2026-11-11")).toBeNull();
    expect(model.toggleSelection("2026-11-11", model.MISSED_SELECTION)).toBe("missed");
    expect(model.selectionIds(DUE, "2026-11-13")).toEqual(ids(4));
    expect(model.selectionIds(DUE, "missed")).toEqual(ids(8, 9));
    expect(model.selectionIds(DUE, null)).toEqual([]);
  });
});

describe("due highlight set", () => {
  it("keys a todo by id and repo, notifies, and clears", () => {
    const seen = vi.fn();
    const off = highlight.onDueHighlight(seen);
    highlight.setDueHighlight("missed", ids(8));
    expect(highlight.isDueHit("pc-8", "C:\\Projects\\Conductor\\")).toBe(true);
    expect(highlight.isDueHit("pc-8", "C:/Projects/other")).toBe(false);
    expect(highlight.isDueHit("pc-9", CWD)).toBe(false);
    highlight.setDueHighlight(null, ids(8));
    expect(highlight.isDueHit("pc-8", CWD)).toBe(false);
    expect(seen).toHaveBeenCalledTimes(2);
    off();
  });
});

describe("Backlog list rows", () => {
  it("wear is-hit exactly for the highlighted todos of the list's own folder", async () => {
    const { listHtml } = await import("../src/views/sessions/backlog-panel/backlog-render.ts");
    const todo = (id) => ({ id, title: id, origin: "dev", claimed: false });
    const groups = [{ name: null, items: [todo("pc-8"), todo("pc-9")] }];
    highlight.setDueHighlight("missed", ids(8));
    const el = document.createElement("div");
    el.innerHTML = listHtml(groups, { selectedId: null, draggable: false, cwd: CWD });
    expect([...el.querySelectorAll(".bl-row.is-hit")].map((r) => r.dataset.blId)).toEqual(["pc-8"]);
    el.innerHTML = listHtml(groups, { selectedId: null, draggable: false, cwd: "C:/Projects/other" });
    expect(el.querySelector(".is-hit")).toBeNull();
    highlight.setDueHighlight(null, []);
  });
});

describe("Due card", () => {
  beforeEach(() => { resetDashboard(); highlight.setDueHighlight(null, []); });
  const due = (root) => root.querySelector('[data-pd-card="due"]');

  it("is absent when nothing is due and none missed", async () => {
    dash.snapshot = projectSnapshot({ due: NONE });
    expect(due(await mount({ kind: "project", id: "p1" }))).toBeNull();
  });

  it("shows counts and labels only, a missed pill, and Do all due (N) = missed + today", async () => {
    dash.snapshot = projectSnapshot({ due: DUE });
    const el = due(await mount({ kind: "project", id: "p1" }));
    expect(el.querySelector(".pd-count").textContent).toBe("6");
    expect(el.querySelector("[data-pd-due-all]").textContent).toBe("Do all due (4)");
    const cells = [...el.querySelectorAll("[data-pd-due-day]")];
    expect(cells.map((c) => c.querySelector(".pd-due-n").textContent)).toEqual(["2", "1", "0", "1", "0"]);
    expect(cells.map((c) => c.querySelector(".pd-due-l").textContent)).toEqual(["Today", "Wed 11", "Thu 12", "Fri 13", "Sat 14"]);
    expect(cells[0].classList.contains("is-today")).toBe(true);
    expect(el.querySelector("[data-pd-due-missed]").textContent).toBe("2 missed");
    expect(el.textContent).not.toMatch(/pc-\d/);
  });

  it("hides Do all and the pill when only a later day has todos", async () => {
    dash.snapshot = projectSnapshot({ due: { days: DUE.days.map((d, i) => (i === 0 ? day(d.date, []) : d)), missed_ids: [] } });
    const el = due(await mount({ kind: "project", id: "p1" }));
    expect(el.querySelector("[data-pd-due-all]")).toBeNull();
    expect(el.querySelector("[data-pd-due-missed]")).toBeNull();
  });

  it("a day click highlights exactly that day's todos, and a second click clears it", async () => {
    dash.snapshot = projectSnapshot({ due: DUE });
    const root = await mount({ kind: "project", id: "p1" });
    const cell = () => due(root).querySelectorAll("[data-pd-due-day]")[1];
    cell().click();
    expect(cell().classList.contains("on")).toBe(true);
    expect(highlight.isDueHit("pc-3", CWD)).toBe(true);
    expect(highlight.isDueHit("pc-1", CWD)).toBe(false);
    due(root).querySelector("[data-pd-due-missed]").click();
    expect(cell().classList.contains("on")).toBe(false);
    expect(highlight.isDueHit("pc-8", CWD)).toBe(true);
    due(root).querySelector("[data-pd-due-missed]").click();
    expect(highlight.isDueHit("pc-8", CWD)).toBe(false);
  });

  it("Do all due starts one chat with exactly the missed and today ids", async () => {
    dash.snapshot = projectSnapshot({ due: DUE });
    state.launchNewChatCallback = vi.fn();
    const root = await mount({ kind: "project", id: "p1" });
    due(root).querySelector("[data-pd-due-all]").click();
    await vi.waitFor(() => expect(state.launchNewChatCallback).toHaveBeenCalledTimes(1));
    expect(state.launchNewChatCallback.mock.calls[0][1].initialMessage).toBe("/auto-do-todos pc-8,pc-9,pc-1,pc-2");
  });

  it("in a group, Do all due asks which repo and sends only that repo's ids", async () => {
    const [app, , , api] = ZIRTUE_REPOS;
    const groupDue = {
      days: [day("2026-11-10", [{ id: "pc-1", repo_cwd: app.cwd }, { id: "pc-1", repo_cwd: api.cwd }, { id: "pc-2", repo_cwd: api.cwd }])],
      missed_ids: [],
    };
    dash.snapshot = projectSnapshot({ target: groupRow().target, due: groupDue });
    resolveNewChatConfig.mockResolvedValue({});
    state.launchNewChatCallback = vi.fn();
    const root = await mount({ kind: "group", id: "g1" });
    const btn = due(root).querySelector("[data-pd-due-all]");
    expect(btn.textContent).toBe("Do all due (3)");
    btn.click();
    const items = () => [...document.querySelectorAll(".session-more-menu .smore-item")];
    await vi.waitFor(() => expect(items()).toHaveLength(2));
    expect(items().map((b) => b.textContent)).toEqual(["zng-app (1)", "zng-api (2)"]);
    items()[1].click();
    await vi.waitFor(() => expect(state.launchNewChatCallback).toHaveBeenCalledTimes(1));
    const [project, config] = state.launchNewChatCallback.mock.calls[0];
    expect(project.path).toBe(api.cwd);
    expect(config.initialMessage).toBe("/auto-do-todos pc-1,pc-2");
  });
});

describe("the due highlight follows its dashboard", () => {
  beforeEach(() => { resetDashboard(); highlight.setDueHighlight(null, []); });

  it("is gone once the dashboard is torn down", async () => {
    dash.snapshot = projectSnapshot({ due: DUE });
    const h = mountDashboard({ kind: "project", id: "p1" }, { mode: "page", pane: document.body, leave: vi.fn(), back: vi.fn(), deselect: vi.fn() });
    document.body.appendChild(h.root);
    await vi.waitFor(() => expect(h.root.querySelector("[data-pd-due-missed]")).not.toBeNull());
    h.root.querySelector("[data-pd-due-missed]").click();
    expect(highlight.dueSelection()).toBe("missed");
    h.destroy();
    expect(highlight.dueSelection()).toBeNull();
    expect(highlight.isDueHit("pc-8", CWD)).toBe(false);
  });

  it("does not carry over to the next dashboard that opens", async () => {
    highlight.setDueHighlight("missed", ids(8));
    dash.snapshot = projectSnapshot({ due: DUE });
    const root = await mount({ kind: "project", id: "p2" });
    expect(highlight.dueSelection()).toBeNull();
    expect(root.querySelector("[data-pd-due-day].on, [data-pd-due-missed].on")).toBeNull();
    expect(highlight.isDueHit("pc-8", CWD)).toBe(false);
  });

  it("re-keys to the new snapshot's todos, and drops a day that left the window", async () => {
    dash.snapshot = projectSnapshot({ due: DUE });
    const h = mountDashboard({ kind: "project", id: "p1" }, { mode: "page", pane: document.body, leave: vi.fn(), back: vi.fn(), deselect: vi.fn() });
    document.body.appendChild(h.root);
    await vi.waitFor(() => expect(h.root.querySelectorAll("[data-pd-due-day]")).toHaveLength(5));
    h.root.querySelectorAll("[data-pd-due-day]")[1].click();
    expect(highlight.isDueHit("pc-3", CWD)).toBe(true);
    dash.snapshot = projectSnapshot({ due: { ...DUE, days: DUE.days.map((d, i) => (i === 1 ? day(d.date, ids(7)) : d)) } });
    h.refresh();
    await vi.waitFor(() => expect(highlight.isDueHit("pc-7", CWD)).toBe(true));
    expect(highlight.isDueHit("pc-3", CWD)).toBe(false);
    dash.snapshot = projectSnapshot({ due: { ...DUE, days: DUE.days.slice(2) } });
    h.refresh();
    await vi.waitFor(() => expect(highlight.dueSelection()).toBeNull());
    expect(highlight.isDueHit("pc-7", CWD)).toBe(false);
    h.destroy();
  });
});
