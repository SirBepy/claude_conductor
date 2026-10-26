// @vitest-environment jsdom
//
// The dashboard inside a new-chat draft: which dashboard a draft's repo opens,
// what the draft variant leaves out (header, "+ New chat"), chips typing into
// the draft's own message box instead of sending, the right-click menu, and
// the Usage card's day totals.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { groupRow, groupSnapshot, history, projectRow, projectSnapshot, ZIRTUE_REPOS } from "./helpers/project-dashboard-fixtures.mjs";

globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);

const calls = [];
let snapshot = projectSnapshot();
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn(async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "dashboard_list_targets") return [groupRow(), projectRow()];
    if (cmd === "dashboard_snapshot") return snapshot;
    if (cmd === "dashboard_history") return history({ quick_actions: [{ command: "/pickup", count: 3 }, { command: "/audit", count: 1 }] });
    return null;
  }),
}));
vi.mock("../src/shared/transport.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isRemote: () => false, getTransport: () => ({ listen: async () => () => {} }) };
});
vi.mock("../src/shared/token-history.ts", () => ({ loadTokenHistory: vi.fn(async () => []) }));
vi.mock("../src/views/sessions/active-session.ts", () => ({ dismountActivePane: vi.fn(), selectSession: vi.fn(async () => {}) }));
vi.mock("../src/views/sessions/model-effort-modal.ts", () => ({ openModelEffortModal: vi.fn() }));
vi.mock("../src/views/sessions/close-chat.ts", () => ({ closeChatWithConfirm: vi.fn(async () => {}) }));

const { mountDraftDashboard, unmountDraftDashboard } = await import("../src/views/sessions/project-dashboard/draft-dashboard.ts");
const { withCommand } = await import("../src/views/sessions/project-dashboard/dash-actions.ts");
const { usageByDay } = await import("../src/views/sessions/project-dashboard/dash-usage.ts");
const { state } = await import("../src/views/sessions/state.ts");

/** The draft pane shape pending-pane-mount.ts builds, minus the header. */
function draftPane() {
  const pane = document.createElement("div");
  pane.innerHTML = `<div class="session-messages"></div><div class="composer-shell"><div class="session-composer"></div></div>`;
  document.body.appendChild(pane);
  return pane;
}

async function mountDraft(path) {
  const pane = draftPane();
  mountDraftDashboard(pane, { path }, state.mountId);
  await vi.waitFor(() => expect(pane.querySelector(".pd-root .pd-reports")).not.toBeNull());
  return pane;
}

const chips = (pane) => [...pane.querySelectorAll(".pd-qa-host .pd-chip")].map((c) => c.textContent.trim());

beforeEach(() => {
  document.body.innerHTML = "";
  calls.length = 0;
  snapshot = projectSnapshot();
  state.composer = null;
});

describe("withCommand", () => {
  it("types the command into an empty box, ready for arguments", () => {
    expect(withCommand("", "/pickup")).toBe("/pickup ");
  });

  it("keeps what was already typed as the command's arguments", () => {
    expect(withCommand("fix the login bug", "/pickup")).toBe("/pickup fix the login bug");
  });

  it("swaps a command already leading the box instead of stacking a second one", () => {
    expect(withCommand("/audit 1296", "/pickup")).toBe("/pickup 1296");
  });
});

describe("draft dashboard", () => {
  it("a repo of a group opens the group's dashboard, the same one for every repo", async () => {
    snapshot = groupSnapshot();
    for (const repo of [ZIRTUE_REPOS[0], ZIRTUE_REPOS[2]]) {
      calls.length = 0;
      const pane = await mountDraft(repo.cwd);
      expect(calls.find((c) => c.cmd === "dashboard_snapshot").args.target).toEqual({ kind: "group", id: "g1" });
      unmountDraftDashboard(pane);
    }
  });

  it("has no header of its own, puts past results first, and its chips sit right above the message box", async () => {
    const pane = await mountDraft("C:/Projects/conductor");
    expect(pane.querySelector(".pd-head")).toBeNull();
    expect(pane.querySelector(".pd-root").firstElementChild.classList.contains("pd-reports")).toBe(true);
    await vi.waitFor(() => expect(chips(pane)).toEqual(["/pickup", "/audit"]));
    // A sibling right before the bordered shell, never inside it.
    expect(pane.querySelector(".composer-shell").previousElementSibling.classList.contains("pd-qa-host")).toBe(true);
  });

  it("a chip types its command into this draft's message box and sends nothing", async () => {
    const composer = { getDraftText: vi.fn(() => "the flaky test"), setDraftText: vi.fn(), sendText: vi.fn(), focus: vi.fn() };
    state.composer = composer;
    const launch = vi.fn();
    state.launchNewChatCallback = launch;
    const pane = await mountDraft("C:/Projects/conductor");
    await vi.waitFor(() => expect(chips(pane)).toContain("/pickup"));
    pane.querySelector('[data-pd-chip="/pickup"]').click();
    expect(composer.setDraftText).toHaveBeenCalledWith("/pickup the flaky test", false);
    expect(composer.sendText).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("a card's button sends its command and the card's data from this draft at once", async () => {
    snapshot = groupSnapshot();
    const composer = { getDraftText: vi.fn(() => ""), setDraftText: vi.fn(), sendText: vi.fn(), focus: vi.fn() };
    state.composer = composer;
    const launch = vi.fn();
    state.launchNewChatCallback = launch;
    const pane = await mountDraft(ZIRTUE_REPOS[0].cwd);
    await vi.waitFor(() => expect(pane.querySelector('[data-pd-card="card:c5"] [data-pd-action]')).not.toBeNull());
    pane.querySelector('[data-pd-card="card:c5"] [data-pd-action]').click();
    expect(composer.sendText).toHaveBeenCalledTimes(1);
    expect(composer.sendText.mock.calls[0][0]).toMatch(/^\/shortcut-priorities\n\nContext, not arguments:[\s\S]*sc-4821 Retry ACH/);
    expect(launch).not.toHaveBeenCalled();
  });

  it("comes down with its chips on unmount", async () => {
    const pane = await mountDraft("C:/Projects/conductor");
    unmountDraftDashboard(pane);
    expect(pane.querySelector(".pd-draft")).toBeNull();
    expect(pane.querySelector(".pd-qa-host")).toBeNull();
  });
});

describe("right-click menu", () => {
  const rightClick = (el) => el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  const items = () => [...document.querySelectorAll(".session-more-menu .smore-item")].map((b) => b.textContent.trim());
  // The menu opens once the automation-flag read (channelFor) settles.
  const opened = () => vi.waitFor(() => expect(items().length).toBeGreaterThan(0));

  it("puts a live chat's own actions above the project's, split by a divider", async () => {
    state.sessions = [{ session_id: "s-w" }];
    const pane = await mountDraft("C:/Projects/conductor");
    const row = [...pane.querySelectorAll(".pd-row")].find((r) => r.textContent.includes("Loop todos cycle 3"));
    rightClick(row);
    await opened();
    expect(items().slice(0, 3)).toEqual(["Open chat", "Close chat...", "Rename project..."]);
    expect(document.querySelector(".session-more-menu .smore-sep")).not.toBeNull();
    expect(items()).toContain("Folder mapping...");
  });

  it("offers copying a commit's hash", async () => {
    const pane = await mountDraft("C:/Projects/conductor");
    rightClick(pane.querySelector('[data-pd-commits="unpushed"]').nextElementSibling);
    await opened();
    expect(items()[0]).toBe("Copy commit hash");
  });

  it("splits commits under Unpushed (N) and Pushed, never shows a hash, and a click copies it", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const pane = await mountDraft("C:/Projects/conductor");
    const ship = pane.querySelector('[data-pd-card="ship"]');
    const labels = [...ship.querySelectorAll("[data-pd-commits]")].map((e) => e.textContent);
    expect(labels).toEqual(["Unpushed (2)", "Pushed"]);
    expect(ship.textContent).not.toContain("dd1af90");
    expect(ship.querySelector('[data-pd-commits="pushed"]').nextElementSibling.textContent).toContain("option-preview card");
    ship.querySelector('[data-pd-commits="unpushed"]').nextElementSibling.click();
    expect(writeText).toHaveBeenCalledWith("dd1af90");
  });

  it("on empty space shows just the project actions", async () => {
    const pane = await mountDraft("C:/Projects/conductor");
    rightClick(pane.querySelector(".pd-root"));
    await opened();
    expect(items()[0]).toBe("Rename project...");
    expect(document.querySelector(".session-more-menu .smore-sep")).toBeNull();
  });
});

describe("usageByDay", () => {
  const rec = (cwd, date, inputTokens) => ({ cwd, date, inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
  const now = new Date(2026, 9, 25, 12);

  it("sums each day across the dashboard's repos and the folders merged into them, oldest first", () => {
    const records = [
      rec("C:/Projects/zng-app", "2026-10-24", 100),
      rec("c:\\projects\\zng-admin", "2026-10-24", 50),
      rec("C:/old/zng-app-v1", "2026-10-23", 7),
      rec("C:/Projects/other", "2026-10-24", 999),
    ];
    const aliases = { "C:/Projects/zng-app": { mergedPaths: ["C:/old/zng-app-v1"] } };
    expect(usageByDay(records, ["C:/Projects/zng-app", "C:/Projects/zng-admin"], aliases, "30d", now)).toEqual([
      { date: "2026-10-23", tokens: 7 },
      { date: "2026-10-24", tokens: 150 },
    ]);
  });

  it("drops days before the range", () => {
    const records = [rec("C:/p", "2026-10-01", 5), rec("C:/p", "2026-10-24", 1)];
    expect(usageByDay(records, ["C:/p"], {}, "7d", now)).toEqual([{ date: "2026-10-24", tokens: 1 }]);
    expect(usageByDay(records, ["C:/p"], {}, "all", now)).toHaveLength(2);
  });
});
