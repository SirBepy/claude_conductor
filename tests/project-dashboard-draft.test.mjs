// @vitest-environment jsdom
//
// The dashboard inside a new-chat draft: which dashboard a draft's repo opens,
// what the draft variant leaves out (header, "+ New chat"), chips typing into
// the draft's own message box instead of sending, the right-click menu, and
// the Usage card's day totals.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
vi.mock("../src/views/sessions/new-chat-config.ts", () => ({ resolveNewChatConfig: vi.fn(), accountPickNeeded: vi.fn(async () => false) }));
vi.mock("../src/views/sessions/close-chat.ts", () => ({ closeChatWithConfirm: vi.fn(async () => {}) }));
// The rail's real controls read accounts, projects and settings; this spec only cares where they land.
const renderSettings = vi.hoisted(() => vi.fn(async (root) => { root.innerHTML = `<div class="rail-stub"></div>`; }));
vi.mock("../src/views/sessions/project-dashboard/project-config/project-settings.ts", () => ({ renderProjectSettings: renderSettings }));

const draftModule = await import("../src/views/sessions/project-dashboard/draft-dashboard.ts");
const { mountDraftDashboard, unmountDraftDashboard } = draftModule;
const motionModule = await import("../src/views/sessions/project-dashboard/dash-motion.ts");
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

  it("a project's draft shows its settings in a rail beside the dashboard, filled for that repo", async () => {
    renderSettings.mockClear();
    const pane = await mountDraft("C:/Projects/conductor");
    const wrap = pane.querySelector(".pd-draft");
    expect(wrap.classList.contains("has-rail")).toBe(true);
    const rail = wrap.querySelector(":scope > .pd-rail");
    expect(rail).not.toBeNull();
    // After the dashboard it sits beside, so the grid puts it in the second column.
    expect(wrap.firstElementChild.classList.contains("pd-root")).toBe(true);
    await vi.waitFor(() => expect(rail.querySelector(".rail-stub")).not.toBeNull());
    expect(rail.hidden).toBe(false);
    expect(renderSettings).toHaveBeenCalledTimes(1);
    expect(renderSettings.mock.calls[0][1]).toBe("C:/Projects/conductor");
  });

  it("a group's draft has no rail: its repos each own their settings", async () => {
    snapshot = groupSnapshot();
    const pane = await mountDraft(ZIRTUE_REPOS[0].cwd);
    expect(pane.querySelector(".pd-rail")).toBeNull();
    expect(pane.querySelector(".pd-draft").classList.contains("has-rail")).toBe(false);
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

describe("draft dashboard motion", () => {
  const { leaveDraftDashboard } = draftModule;
  const { entranceOrder } = motionModule;
  let animations;
  const nativeHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");

  beforeEach(() => {
    animations = [];
    // jsdom has neither Web Animations nor layout.
    HTMLElement.prototype.animate = function (frames, opts) {
      const a = { el: this, frames, opts, onfinish: null, oncancel: null };
      animations.push(a);
      return a;
    };
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 40 });
  });

  afterEach(() => {
    delete HTMLElement.prototype.animate;
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", nativeHeight);
  });

  it("staggers each section in once, and a live repaint does not replay it", async () => {
    const pane = await mountDraft("C:/Projects/conductor");
    await vi.waitFor(() => expect(chips(pane)).toEqual(["/pickup", "/audit"]));
    const played = animations.length;
    expect(played).toBeGreaterThan(2);
    expect(animations.every((a) => a.opts.fill === "backwards")).toBe(true);
    // Later sections wait longer, up to the cap.
    const delays = animations.map((a) => a.opts.delay);
    expect(Math.max(...delays)).toBeGreaterThan(0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(1080);
    // The history and usage loads paint again after the first paint.
    await new Promise((r) => setTimeout(r, 50));
    expect(animations.length).toBe(played);
  });

  it("a section rebuilt mid-wave (a column rebalance) still fades in, timed to its slot; after the wave it does not", () => {
    const { playEntrance } = motionModule;
    const root = document.createElement("div");
    root.innerHTML = '<div class="pd-cols"><div class="pd-col"><section></section></div><div class="pd-col"><section></section></div></div>';
    const chipRow = document.createElement("div");
    let t = 0;
    const entrance = playEntrance(root, chipRow, () => t);
    expect(animations).toHaveLength(2);
    t = 100;
    const rebuilt = document.createElement("section");
    root.querySelector(".pd-col").append(rebuilt);
    entrance.catchUp();
    expect(animations).toHaveLength(3);
    expect(animations[2].el).toBe(rebuilt);
    expect(animations[2].opts.fill).toBe("backwards");
    expect(animations[2].opts.delay).toBeGreaterThanOrEqual(0);
    // Already playing: a later paint leaves it alone.
    entrance.catchUp();
    expect(animations).toHaveLength(3);
    t = 10_000;
    root.querySelector(".pd-col").append(document.createElement("section"));
    entrance.catchUp();
    expect(animations).toHaveLength(3);
  });

  it("orders sections down the page, left before right at the same height", () => {
    const at = (name, top, left) => {
      const el = document.createElement("div");
      el.dataset.n = name;
      el.getBoundingClientRect = () => ({ top, left });
      return el;
    };
    const order = entranceOrder([at("right", 102, 400), at("below", 300, 0), at("left", 100, 0), at("top", 0, 0)]);
    expect(order.map((e) => e.dataset.n)).toEqual(["top", "left", "right", "below"]);
  });

  it("the first send fades a copy out in place and takes the live dashboard down at once", async () => {
    const pane = await mountDraft("C:/Projects/conductor");
    await vi.waitFor(() => expect(chips(pane)).toEqual(["/pickup", "/audit"]));
    animations.length = 0;
    leaveDraftDashboard(pane);
    // The rail goes down with the dashboard: it is part of the copy that fades.
    expect(animations.map((a) => a.el.className)).toEqual(["pd-draft has-rail pd-ghost", "pd-qa-host is-draft pd-ghost"]);
    expect(pane.querySelectorAll(".pd-draft")).toHaveLength(1);
    expect(pane.querySelector(".pd-draft").inert).toBe(true);
    // No live dashboard is left: a refetch cannot repaint into the copy.
    expect(pane.querySelector(".pd-root")).toBe(pane.querySelector(".pd-draft .pd-root"));
    for (const a of animations) a.onfinish();
    expect(pane.querySelector(".pd-draft")).toBeNull();
    expect(pane.querySelector(".pd-qa-host")).toBeNull();
  });

  it("an html card's frame is not cloned into the fading copy, which would reload it", async () => {
    const pane = await mountDraft("C:/Projects/conductor");
    await vi.waitFor(() => expect(chips(pane)).toEqual(["/pickup", "/audit"]));
    // The fixtures hold no html card: stand one in for what dash-html-card.ts renders.
    const frame = document.createElement("iframe");
    frame.className = "pd-html-frame";
    pane.querySelector(".pd-reports").append(frame);
    leaveDraftDashboard(pane);
    const ghost = pane.querySelector(".pd-draft.pd-ghost");
    expect(ghost.querySelector("iframe")).toBeNull();
    // Same size as the frame it replaces, so the fold's layout does not jump.
    expect(ghost.querySelector(".pd-html-frame-ghost").style.height).toBe("40px");
    expect(pane.querySelector("iframe")).toBeNull();
  });

  it("the send's header rebind leaves the fading copy to finish its fold", async () => {
    const pane = await mountDraft("C:/Projects/conductor");
    await vi.waitFor(() => expect(chips(pane)).toEqual(["/pickup", "/audit"]));
    leaveDraftDashboard(pane);
    unmountDraftDashboard(pane);
    expect(pane.querySelector(".pd-draft.pd-ghost")).not.toBeNull();
    expect(pane.querySelector(".pd-qa-host.pd-ghost")).not.toBeNull();
  });

  it("a send mid-entrance keeps a section that has not arrived yet hidden in the fading copy", async () => {
    const pane = await mountDraft("C:/Projects/conductor");
    await vi.waitFor(() => expect(chips(pane)).toEqual(["/pickup", "/audit"]));
    // jsdom has no Web Animations: stand in for a section still waiting out its delay.
    const waiting = pane.querySelector(".pd-reports");
    waiting.getAnimations = () => [{}];
    const native = window.getComputedStyle;
    window.getComputedStyle = (el, ...rest) => (el === waiting ? { opacity: "0", transform: "matrix(1, 0, 0, 1, 0, 10)" } : native(el, ...rest));
    try {
      leaveDraftDashboard(pane);
    } finally {
      window.getComputedStyle = native;
    }
    const copy = pane.querySelector(".pd-ghost .pd-reports");
    expect(copy.style.opacity).toBe("0");
    expect(copy.style.transform).toBe("matrix(1, 0, 0, 1, 0, 10)");
  });
});

describe("right-click menu", () => {
  const rightClick = (el) => el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  const items = () => [...document.querySelectorAll(".session-more-menu .smore-item")].map((b) => b.textContent.trim());
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
    expect(usageByDay(records, ["C:/Projects/zng-app", "C:/Projects/zng-admin"], aliases, "7d", now)).toEqual([
      { date: "2026-10-19", tokens: 0 },
      { date: "2026-10-20", tokens: 0 },
      { date: "2026-10-21", tokens: 0 },
      { date: "2026-10-22", tokens: 0 },
      { date: "2026-10-23", tokens: 7 },
      { date: "2026-10-24", tokens: 150 },
      { date: "2026-10-25", tokens: 0 },
    ]);
  });

  it("covers every day of the range, quiet ones at 0, and All starts on the first active day", () => {
    const records = [rec("C:/p", "2026-09-20", 5), rec("C:/p", "2026-10-24", 1)];
    const month = usageByDay(records, ["C:/p"], {}, "30d", now);
    expect(month).toHaveLength(30);
    expect(month[0].date).toBe("2026-09-26");
    expect(month.at(-1)).toEqual({ date: "2026-10-25", tokens: 0 });
    const all = usageByDay(records, ["C:/p"], {}, "all", now);
    expect(all[0]).toEqual({ date: "2026-09-20", tokens: 5 });
    expect(all).toHaveLength(36);
    expect(usageByDay([], ["C:/p"], {}, "all", now)).toEqual([]);
    // A malformed date is skipped rather than starting All on an Invalid Date.
    expect(usageByDay([rec("C:/p", "1/2/2026", 9), ...records], ["C:/p"], {}, "all", now)).toEqual(all);
  });
});
