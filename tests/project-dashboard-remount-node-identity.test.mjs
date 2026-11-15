// @vitest-environment jsdom
// asserts: src/views/sessions/project-dashboard/dash-line-chart.ts, src/views/sessions/project-dashboard/draft-dashboard.ts
//
// pc-1748: the dashboard beside a chat is mounted into a new tree on every chat
// click (draft-dashboard.ts / dashboard-page.ts build a fresh `mountDashboard`
// root each time). Its charts must come back as the SAME SVG node while their data
// is the same, and without the draw-in class once their first draw has run, or the
// lines animate again on every click. This drives the real mount twice, the way a
// chat click does, instead of rendering one card template.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { projectSnapshot, projectRow, groupRow, history } from "./helpers/project-dashboard-fixtures.mjs";

globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);

let snapshot;
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn(async (cmd) => {
    if (cmd === "dashboard_list_targets") return [groupRow(), projectRow()];
    if (cmd === "dashboard_snapshot") return snapshot;
    if (cmd === "dashboard_history") return history({});
    return null;
  }),
}));
vi.mock("../src/shared/transport.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isRemote: () => false, getTransport: () => ({ listen: async () => () => {} }) };
});
vi.mock("../src/shared/token-history.ts", () => ({ loadTokenHistory: vi.fn(async () => []) }));
vi.mock("../src/views/sessions/active-session.ts", () => ({ dismountActivePane: vi.fn(), selectSession: vi.fn(async () => {}) }));
vi.mock("../src/views/sessions/new-chat-config.ts", () => ({ resolveNewChatConfig: vi.fn(), accountPickNeeded: vi.fn(async () => false) }));
vi.mock("../src/views/sessions/close-chat.ts", () => ({ closeChatWithConfirm: vi.fn(async () => {}) }));
vi.mock("../src/views/sessions/draft-subchats.ts", () => ({ forceDraftPlain: vi.fn() }));
vi.mock("../src/views/sessions/project-dashboard/project-config/project-settings.ts", () => ({
  renderProjectSettings: vi.fn(async (root) => { root.innerHTML = `<div class="rail-stub"></div>`; }),
}));

const { mountDraftDashboard, unmountDraftDashboard } = await import("../src/views/sessions/project-dashboard/draft-dashboard.ts");
const { state } = await import("../src/views/sessions/state.ts");

const days = Array.from({ length: 12 }, (_, i) => ({ date: `2026-11-${String(i + 1).padStart(2, "0")}`, created: i, done: 1, open: 10 + i }));
const todoStats = (over = 0) => ({ days: days.map((d) => ({ ...d, open: d.open + over })), open_now: 12, claimed_now: 1 });

function draftPane() {
  const pane = document.createElement("div");
  pane.innerHTML = `<div class="session-messages"></div><div class="composer-shell"><div class="session-composer"></div></div>`;
  document.body.appendChild(pane);
  return pane;
}

/** One chat click: the previous pane's dashboard goes, a new pane mounts a new one. */
async function clickChat(path, previous) {
  if (previous) unmountDraftDashboard(previous);
  const pane = draftPane();
  mountDraftDashboard(pane, { path }, state.mountId);
  await vi.waitFor(() => expect(pane.querySelector(".pd-root svg[data-line-chart]")).not.toBeNull());
  return pane;
}

/** A snapshot whose chart key (`todos:<repo cwd>:<range>`) is this test's own: the draw-in
 *  bookkeeping is module state, so a shared repo would carry one test's first sighting into the next. */
function snapshotFor(key, over = {}) {
  const snap = projectSnapshot({ todo_stats: todoStats(), ...over });
  snap.target = { ...snap.target, repos: [{ ...snap.target.repos[0], cwd: key }] };
  return snap;
}

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => vi.useRealTimers());

describe("the dashboard beside a chat, mounted again on a chat click", () => {
  it("keeps the chart node while the data is the same and builds a new one when it changes", async () => {
    const path = "C:/Projects/conductor";
    snapshot = snapshotFor("C:/node-identity-mount/a");
    const first = await clickChat(path);
    const node = first.querySelector(".pd-root svg[data-line-chart]");
    const second = await clickChat(path, first);
    expect(second).not.toBe(first);
    expect(second.querySelector(".pd-root svg[data-line-chart]")).toBe(node);

    snapshot = snapshotFor("C:/node-identity-mount/a", { todo_stats: todoStats(5) });
    const third = await clickChat(path, second);
    expect(third.querySelector(".pd-root svg[data-line-chart]")).not.toBe(node);
  });

  it("does not draw the lines in again once the first draw has run", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-15T10:00:00Z"));
    const path = "C:/Projects/conductor";
    snapshot = snapshotFor("C:/node-identity-mount/b");
    const first = await clickChat(path);
    expect(first.querySelectorAll(".pd-root path.chart-line-draw").length).toBeGreaterThan(0);
    vi.setSystemTime(new Date("2026-11-15T10:00:30Z"));
    const second = await clickChat(path, first);
    expect(second.querySelectorAll(".pd-root path[data-line]").length).toBeGreaterThan(0);
    expect(second.querySelectorAll(".pd-root path.chart-line-draw")).toHaveLength(0);
  });
});
