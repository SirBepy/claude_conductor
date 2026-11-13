// Reviewed 2026-11-13 (stale blockers): Waiting on you drops an own blocker once the chat sends a later report, answer, plan or same-target blocker, each Waiting card gains a written time and a hover x (Clear all once two can go) kept per chat in localStorage, and the card copy button is hidden there; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-12 (the /close quick-reply chip and the close-failed state are removed from the sessions list, hover card and chat chrome; a sub card's Close calls closeChat): nothing this spec asserts changed. It passes.
// Reviewed 2026-11-12 (plan body): the Plan card draws a plan message's lines after its headline under it, muted; nothing this spec asserts changed, and it passes.
// asserts: src/views/sessions/main-chat.ts, src/views/sessions/sub-list.ts, src/views/sessions/sub-list.css, src/views/sessions/sidebar-ring.ts, src/views/sessions/sidebar-ring.css, src/views/sessions/sidebar-hover-card-html.ts, src/views/sessions/sidebar-hover-card.css, src/views/sessions/chat-dashboard/sub-hover.ts, src/views/sessions/chat-dashboard/subs-card.ts, src/views/sessions/chat-dashboard/plan-card.ts, src/views/sessions/chat-dashboard/chat-dashboard.css, src/views/sessions/chat-menu-items.ts, src/views/sessions/chat-menu.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance, userMsg } from "./harness";

// Honest sub states (docs/chat-dashboard-design.md, "Seeing what subs are doing"):
// a sub that is not making progress draws a dim ring and a corner glyph (clock
// queued, pause paused, hourglass usage limit, moon stopped without finishing)
// opposite the battery; its avatar has a real hover card; the Plan card's foot
// counts the subs; the main chat's sidebar ring glows while a sub works and does
// not stay green; a queued sub's menu has Start now and Drop.

const CWD = "C:/Projects/cv-site";
const MIN = 60_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
type Over = Parameters<typeof sessionInstance>[0];
const chat = (id: string, name: string, pid: number, over: Over = {}) => sessionInstance({ session_id: id, name, pid, cwd: CWD, ...over });
const sub = (id: string, name: string, pid: number, over: Over = {}) =>
  chat(id, name, pid, { subchat_of: "main", busy: false, awaiting: null, started_at: ago(12 * MIN), ...over });

const PLAN = [
  { text: "Read", status: "done" }, { text: "Edit footer.css", status: "active" }, { text: "Verify", status: "pending" },
] as const;

const MAIN = chat("main", "CV redesign", 101);
const WORK = sub("w", "Footer", 102, {
  busy: true,
  progress: { plan: [...PLAN], state_since: ago(2 * MIN), last_action: "Editing footer.css", last_action_at: ago(18_000) } as never,
});
const ASK = sub("a", "Header", 103, { awaiting: "question" });
const QUEUED = sub("q", "Contact form", 104, {
  progress: { plan: null, state_since: null, waiting_for: "waiting for the writer slot", queue_place: 2, queue_behind: "Footer" } as never,
});
const PAUSED = sub("p", "Colours", 105, { frozen: true });
const GAMING = sub("g", "Fonts", 106, { progress: { plan: null, state_since: null, parked: true } as never });
const LIMITED = sub("l", "Icons", 107, { rate_limited_resets_at: Math.floor(Date.now() / 1000) + 90 * 60 } as never);
const STOPPED = sub("s", "Sitemap", 108, {
  progress: { plan: [...PLAN], state_since: ago(5 * MIN), stopped_unfinished: true, last_action: "Running tests", last_action_at: ago(125_000) } as never,
});
const DONE = sub("d", "Copy", 109, { subchat_finished: true, awaiting: "done", progress: { plan: null, state_since: ago(10 * MIN) } });

const SEND = "mcp__cc_conductor__send_message";
const HISTORY = [
  userMsg("build the new CV site"),
  { type: "tool_use", tool_name: SEND, input: { kind: "plan", verdict: "Jobs out", text: "Handed out." }, id: "t1", timestamp: 0, parent_tool_use_id: null },
  { type: "tool_result", tool_use_id: "t1", output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 },
];

function invokeFor(sessions: unknown[]) {
  return {
    ...SESSIONS_BASE_INVOKE,
    list_instances: sessions,
    get_active_sessions: sessions,
    list_subchats_on: ["main"],
    load_history_page: { events: HISTORY, oldest_seq: 0, newest_seq: HISTORY.length, has_more: false },
    context_status: { model: "claude-opus-5", window: 1_000_000, occupancy: 340_000, remaining: 660_000, pct_used: 34, pct_left: 66 },
    list_subchat_cards: [], list_session_images: { images: [] }, get_sub_brief: { brief: null }, list_previews: [],
    start_queued_sub: null, drop_queued_sub: null, freeze_session: null, unfreeze_session: null,
  };
}

async function openMain(page: Page, sessions: unknown[]): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mountView(page, { view: "sessions", chatView: "dashboard", invoke: invokeFor(sessions) });
  await page.locator(`#sessions-list li[data-session-id="main"]`).click();
  await page.locator("#session-pane .cdash").waitFor();
}

const card = (page: Page) => page.locator("#session-pane .cdash-right .cdash-subs");
const av = (page: Page, id: string) => card(page).locator(`.sx-av[data-sub="${id}"]`);
const hover = (page: Page) => page.locator(".sx-hover-card");
const ALL = [MAIN, WORK, ASK, QUEUED, PAUSED, GAMING, LIMITED, STOPPED, DONE];

async function hoverCard(page: Page, id: string): Promise<void> {
  await page.mouse.move(2, 2);
  await av(page, id).hover();
  await expect(hover(page)).toBeVisible();
  await expect(hover(page)).toHaveAttribute("data-sub", id);
}

test.describe("honest sub states", () => {
  test("the four idle states draw a dim ring and a corner glyph opposite the battery; working, asking and finished draw none", async ({ page }) => {
    await openMain(page, ALL);
    const expected: Record<string, string> = { q: "queued", p: "paused", g: "paused", l: "limited", s: "stopped" };
    const icon: Record<string, string> = { queued: "ph-clock", paused: "ph-pause", limited: "ph-hourglass-medium", stopped: "ph-moon" };
    for (const [id, kind] of Object.entries(expected)) {
      await expect(av(page, id)).toHaveAttribute("data-kind", kind);
      await expect(av(page, id).locator('circle[data-tone="dim"]').first()).toBeVisible();
      await expect(av(page, id).locator('circle[data-tone="working"]')).toHaveCount(0);
      await expect(av(page, id).locator(`.sub-glyph[data-glyph="${kind}"] i.${icon[kind]!}`)).toBeVisible();
      // Top-left corner, the battery's opposite: the glyph never reads as effort or as asking.
      const a = (await av(page, id).boundingBox())!;
      const g = (await av(page, id).locator(".sub-glyph").boundingBox())!;
      const b = (await av(page, id).locator(".session-model-battery").boundingBox())!;
      expect(g.x + g.width / 2).toBeLessThan(a.x + a.width / 2);
      expect(g.y + g.height / 2).toBeLessThan(a.y + a.height / 2);
      expect(b.x + b.width / 2).toBeGreaterThan(a.x + a.width / 2);
      expect(b.y + b.height / 2).toBeGreaterThan(a.y + a.height / 2);
    }
    for (const id of ["w", "a", "d"]) await expect(av(page, id).locator(".sub-glyph")).toHaveCount(0);
    await expect(av(page, "w").locator("svg.is-glow, svg.is-plan")).toHaveCount(1);
    await expect(av(page, "a").locator('circle[data-tone="question"]').first()).toBeVisible();
    await expect(av(page, "d").locator('circle[data-tone="done"]').first()).toBeVisible();
    // No native title competes with the hover card.
    await expect(av(page, "w")).not.toHaveAttribute("title", /.+/);
    await capture(page.locator("#session-pane"), "sub-states-card");
  });

  test("the working sub's hover card names the state, step, time running, last action and context", async ({ page }) => {
    await openMain(page, ALL);
    await hoverCard(page, "w");
    const c = hover(page);
    await expect(c.locator(".hc-title")).toHaveText("Footer");
    await expect(c.locator(".hc-state")).toContainText("Working");
    await expect(c.locator(".hc-timer")).toHaveText(/^running 1\d:\d\d$/);
    await expect(c.locator(".hc-heading")).toHaveText("Step 2 of 3");
    await expect(c.locator(".hc-row.is-now")).toHaveText("Edit footer.css");
    await expect(c.locator(".hc-row", { hasText: "Editing footer.css" }).locator(".hc-aside")).toHaveText(/^\d+s ago$/);
    await expect(c.locator(".hc-ctx")).toHaveText("34%");
    // The sidebar row card's chrome.
    await expect(c).toHaveClass(/info-tooltip/);
    await expect(c).toHaveClass(/cc-row-card/);
    await capture(page, "sub-states-hover-working");
  });

  test("a queued sub's card says what it waits for and its place in line, and shows no run time", async ({ page }) => {
    await openMain(page, ALL);
    await hoverCard(page, "q");
    const c = hover(page);
    await expect(c.locator(".hc-state")).toContainText("Queued");
    await expect(c.locator(".hc-timer")).toHaveCount(0);
    await expect(c).toContainText("waiting for the writer slot");
    await expect(c).toContainText("Place 2 in line");
    await expect(c).toContainText("Behind Footer");
    await capture(page, "sub-states-hover-queued");
  });

  test("paused, gaming-parked, usage-limited and stopped subs each say so on their card", async ({ page }) => {
    await openMain(page, ALL);
    await hoverCard(page, "p");
    await expect(hover(page).locator(".hc-state")).toContainText("Paused");
    await capture(page, "sub-states-hover-paused");
    await hoverCard(page, "g");
    await expect(hover(page)).toContainText("Gaming mode paused it");
    await hoverCard(page, "l");
    await expect(hover(page).locator(".hc-state")).toContainText("Usage limit");
    await expect(hover(page)).toContainText(/Resets at \d/);
    await capture(page, "sub-states-hover-limit");
    await hoverCard(page, "s");
    await expect(hover(page).locator(".hc-state")).toContainText("Stopped without finishing");
    await expect(hover(page).locator(".hc-heading")).toHaveText("Step 2 of 3");
    await expect(hover(page).locator(".hc-row", { hasText: "Running tests" }).locator(".hc-aside")).toHaveText("2m ago");
    await capture(page, "sub-states-hover-stopped");
    // Leaving the avatar takes the card away.
    await page.mouse.move(2, 2);
    await expect(hover(page)).toBeHidden();
  });

  test("the Plan card's foot counts the subs, then says the chat's own state muted", async ({ page }) => {
    await openMain(page, ALL);
    const foot = page.locator("#session-pane .cdash-plan [data-slot='status']");
    await expect(foot.locator(".cdash-pcounts")).toHaveText("1 working · 1 asking · 1 queued · 2 paused · 1 at usage limit · 1 stopped");
    await expect(foot.locator(".cdash-pstatus-own")).toContainText(/^This chat (idle|is waiting)/);
    const own = await foot.locator(".cdash-pstatus-own").evaluate((e) => getComputedStyle(e).color);
    const main = await foot.locator(".cdash-pcounts").evaluate((e) => getComputedStyle(e).color);
    expect(own).not.toBe(main);
    await capture(page.locator("#session-pane .cdash-plan"), "sub-states-plan-foot");
  });

  test("with every sub finished the foot keeps its plain idle line", async ({ page }) => {
    await openMain(page, [MAIN, DONE]);
    const foot = page.locator("#session-pane .cdash-plan [data-slot='status']");
    await expect(foot.locator(".cdash-pcounts")).toHaveCount(0);
    await expect(foot).toContainText(/Idle|Waiting/);
  });

  test("the main chat's ring glows while a sub works", async ({ page }) => {
    await openMain(page, [MAIN, WORK, QUEUED]);
    const ring = page.locator(`#sessions-list li[data-session-id="main"] .avatar-ring circle`);
    await expect(ring.first()).toHaveAttribute("data-tone", "working");
    await expect(ring.first()).toHaveClass(/is-glow/);
    await capture(page.locator("#sessions-list"), "sub-states-main-ring-glow");
  });

  test("the main chat's ring does not glow for queued, paused or stopped subs, and does not stay green once every sub finished", async ({ page }) => {
    await openMain(page, [MAIN, QUEUED, PAUSED, STOPPED]);
    await expect(page.locator(`#sessions-list li[data-session-id="main"] .avatar-ring circle.is-glow`)).toHaveCount(0);
    // The repro for "it goes green and never stops being green": every sub finished and the chat read.
    await openMain(page, [MAIN, DONE, { ...DONE, session_id: "d2", name: "More copy", pid: 110 }]);
    await expect(page.locator(`#sessions-list li[data-session-id="main"] .avatar-ring circle[data-tone="done"]`)).toHaveCount(0);
    await expect(page.locator(`#sessions-list li[data-session-id="main"] .avatar-ring`)).toHaveCount(0);
  });

  // Joe, 2026-11-12: "they should only glow green IF ALLLL of the subchats are done... only then".
  // An unread finish is the state that draws green on any chat, so seed it before the list mounts.
  async function mountUnreadMain(page: Page, sessions: unknown[]): Promise<void> {
    await page.addInitScript(() => localStorage.setItem("cc_session_unread", JSON.stringify(["main"])));
    await page.setViewportSize({ width: 1280, height: 900 });
    await mountView(page, { view: "sessions", chatView: "dashboard", invoke: invokeFor(sessions) });
    await page.locator(`#sessions-list li[data-session-id="main"]`).waitFor();
  }
  const mainRing = (page: Page) => page.locator(`#sessions-list li[data-session-id="main"] .avatar-ring circle`);

  test("the main chat's ring is green when its own turn is done and every sub finished", async ({ page }) => {
    await mountUnreadMain(page, [MAIN, DONE, { ...DONE, session_id: "d2", name: "More copy", pid: 110 }]);
    await expect(mainRing(page).first()).toHaveAttribute("data-tone", "done");
    await capture(page.locator("#sessions-list"), "sub-states-main-ring-green-all-done");
  });

  for (const [label, unfinished] of [["queued", QUEUED], ["stopped", STOPPED], ["paused", PAUSED], ["at its usage limit", LIMITED]] as const) {
    test(`one ${label} sub among finished ones keeps the main chat's ring off green`, async ({ page }) => {
      await mountUnreadMain(page, [MAIN, DONE, { ...DONE, session_id: "d2", name: "More copy", pid: 110 }, unfinished]);
      await expect(page.locator(`#sessions-list li[data-session-id="main"] .avatar-ring`)).toHaveCount(0);
    });
  }

  test("a working sub among finished ones makes the main chat's ring glow, not green", async ({ page }) => {
    await mountUnreadMain(page, [MAIN, DONE, WORK]);
    await expect(mainRing(page).first()).toHaveAttribute("data-tone", "working");
    await expect(mainRing(page).first()).toHaveClass(/is-glow/);
  });

  test("a sub that asks gives the main chat's ring the attention pulse, not green", async ({ page }) => {
    await mountUnreadMain(page, [MAIN, DONE, ASK]);
    await expect(mainRing(page).first()).toHaveAttribute("data-tone", "attention");
    await expect(mainRing(page).first()).toHaveClass(/is-pulse/);
  });

  test("a queued sub's menu leads with Start now and Drop and nests what needs a running sub", async ({ page }) => {
    await openMain(page, ALL);
    await av(page, "q").click({ button: "right" });
    const menu = page.locator(".sx-menu");
    await expect(menu.locator(".smore-item")).toHaveText(["Open", "Open in new window", "Latest preview", "Start now", "Pin to sidemenu", "Once it has started", "Drop"]);
    await expect(menu.locator(".smore-item", { hasText: "Drop" })).toHaveClass(/smore-danger/);
    for (const label of ["Pause", "Stop this turn", "Change model", "Change effort", "Close"]) {
      await expect(menu.locator(".smore-item", { hasText: new RegExp(`^${label}$`) })).toHaveCount(0);
    }
    await menu.locator(".smore-item", { hasText: "Once it has started" }).click();
    const nested = page.locator(".chat-menu-submenu");
    await expect(nested.locator(".smore-item")).toHaveText(["Pause", "Stop this turn", "Change model", "Change effort", "Close"]);
    await expect(nested.locator(".smore-item.is-disabled")).toHaveCount(5);
    await capture(page, "sub-states-queued-menu");

    // A disabled child does nothing, and neither level of the menu is torn down around it.
    await nested.locator(".smore-item", { hasText: "Pause" }).click();
    expect((await invokeCalls(page)).filter((c) => c.cmd === "freeze_session")).toHaveLength(0);
    await expect(nested).toBeVisible();
    await expect(menu).toBeVisible();
    // An outside click closes both.
    await page.mouse.click(5, 5);
    await expect(nested).toHaveCount(0);
    await expect(menu).toHaveCount(0);
  });

  test("Start now and Drop call the desktop RPCs for that sub", async ({ page }) => {
    await openMain(page, ALL);
    await av(page, "q").click({ button: "right" });
    await page.locator(".sx-menu .smore-item", { hasText: "Start now" }).click();
    await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "start_queued_sub").length).toBe(1);
    expect((await invokeCalls(page)).find((c) => c.cmd === "start_queued_sub")!.args).toMatchObject({ sessionId: "q" });
    await av(page, "q").click({ button: "right" });
    await page.locator(".sx-menu .smore-item", { hasText: "Drop" }).click();
    await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "drop_queued_sub").length).toBe(1);
    expect((await invokeCalls(page)).find((c) => c.cmd === "drop_queued_sub")!.args).toMatchObject({ sessionId: "q" });
  });

  test("the header's sub list files the idle subs under Not running with their glyphs", async ({ page }) => {
    await openMain(page, ALL);
    await page.locator(".sub-count-btn").click();
    const pop = page.locator(".sub-list-popover");
    await expect(pop.locator(".sub-list-head")).toHaveText(["Running", "Queued", "Not running", "Finished"]);
    await expect(pop.locator('.sub-row[data-sub-id="s"] .sub-glyph[data-glyph="stopped"]')).toBeVisible();
    await expect(pop.locator('.sub-row[data-sub-id="l"] .sub-status')).toContainText("usage limit, resets");
    await capture(page, "sub-states-header-list");
  });
});
