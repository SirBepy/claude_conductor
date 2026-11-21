// Reviewed 2026-11-21 (put away, pc-1806 step 5): a project's main chat that the daemon put away (hidden_at) joins the Hidden view with a Paused badge, opens read-only, and its Close reads Put away; nothing this spec asserts changed (its chats carry no hidden_at), and it passes in the run of every spec that depends on those files.
// Reviewed 2026-11-16 (chat heads, pc-1769): the sidebar rows, group headers and red dots became chat heads; a main chat with nothing to show draws the faint read ring (tone idle) where the row drew no ring, so "off green" asserts tone idle.
// Reviewed 2026-11-13 (stale blockers): Waiting on you drops an own blocker once the chat sends a later report, answer, plan or same-target blocker, each Waiting card gains a written time and a hover x (Clear all once two can go) kept per chat in localStorage, and the card copy button is hidden there; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-12 (the /close quick-reply chip and the close-failed state are removed from the sessions list, hover card and chat chrome; a sub card's Close calls closeChat): nothing this spec asserts changed. It passes.
// Reviewed 2026-11-12 (plan body): the Plan card draws a plan message's lines after its headline under it, muted; nothing this spec asserts changed, and it passes.
// asserts: src/views/sessions/chat-dashboard/sub-queued-popup.ts, src/views/sessions/chat-dashboard/sub-queued-popup.css, src/shared/chat/dashboard/subs-model.ts, src/views/sessions/main-chat.ts, src/views/sessions/sub-list.ts, src/views/sessions/sub-list.css, src/views/sessions/sidebar-ring.ts, src/views/sessions/sidebar-ring.css, src/views/sessions/sidebar-hover-card-html.ts, src/views/sessions/sidebar-hover-card.css, src/views/sessions/chat-dashboard/sub-hover.ts, src/views/sessions/chat-dashboard/subs-card.ts, src/views/sessions/chat-dashboard/plan-card.ts, src/views/sessions/chat-dashboard/chat-dashboard.css, src/views/sessions/chat-menu-items.ts, src/views/sessions/chat-menu.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance, userMsg } from "./harness";

// Honest sub states (docs/chat-dashboard-design.md, "Seeing what subs are doing"):
// a sub that is not making progress draws a dim ring and a corner glyph (clock
// queued, pause paused, hourglass usage limit, moon stopped without finishing)
// opposite the battery; its avatar has a real hover card; the Plan card's foot
// counts the subs; the main chat's head wears one red or green number and no ring; a queued sub's
// menu has Start now and Drop.

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
  // Six of these subs are stuck and the card shows five rows before "+N more": open them all.
  const more = page.locator("#session-pane .cdash-left .cdash-subs .sx-more");
  if (await more.count()) await more.click();
}

const card = (page: Page) => page.locator("#session-pane .cdash-left .cdash-subs");
const av = (page: Page, id: string) => card(page).locator(`.sx-av[data-sub="${id}"]`);
// A queued sub is no row or avatar in the card: it is the "N queued" count, whose popup lists it.
const avq = (page: Page, id: string) => page.locator(`.sq-pop .sx-av[data-sub="${id}"]`);
const openQueued = async (page: Page): Promise<void> => {
  await card(page).locator(".sx-queued").click();
  await expect(page.locator(".sq-pop.is-open")).toBeVisible();
};
const hover = (page: Page) => page.locator(".sx-hover-card");
const ALL = [MAIN, WORK, ASK, QUEUED, PAUSED, GAMING, LIMITED, STOPPED, DONE];

async function hoverCard(page: Page, id: string): Promise<void> {
  await page.mouse.move(2, 2);
  await (id === "q" ? avq(page, id) : av(page, id)).hover();
  await expect(hover(page)).toBeVisible();
  await expect(hover(page)).toHaveAttribute("data-sub", id);
}

test.describe("honest sub states", () => {
  test("the four idle states draw a dim ring and a corner glyph opposite the battery; working, asking and finished draw none", async ({ page }) => {
    await openMain(page, ALL);
    const expected: Record<string, string> = { q: "queued", p: "paused", g: "paused", l: "limited", s: "stopped" };
    const icon: Record<string, string> = { queued: "ph-clock", paused: "ph-pause", limited: "ph-hourglass-medium", stopped: "ph-moon" };
    for (const [id, kind] of Object.entries(expected)) {
      if (id === "q") await openQueued(page);
      const sub = id === "q" ? avq(page, id) : av(page, id);
      await expect(sub).toHaveAttribute("data-kind", kind);
      await expect(sub.locator('circle[data-tone="dim"]').first()).toBeVisible();
      await expect(sub.locator('circle[data-tone="working"]')).toHaveCount(0);
      await expect(sub.locator(`.sub-glyph[data-glyph="${kind}"] i.${icon[kind]!}`)).toBeVisible();
      // Top-left corner, the battery's opposite: the glyph never reads as effort or as asking.
      const a = (await sub.boundingBox())!;
      const g = (await sub.locator(".sub-glyph").boundingBox())!;
      const b = (await sub.locator(".session-model-battery").boundingBox())!;
      expect(g.x + g.width / 2).toBeLessThan(a.x + a.width / 2);
      expect(g.y + g.height / 2).toBeLessThan(a.y + a.height / 2);
      expect(b.x + b.width / 2).toBeGreaterThan(a.x + a.width / 2);
      expect(b.y + b.height / 2).toBeGreaterThan(a.y + a.height / 2);
      if (id === "q") await page.keyboard.press("Escape");
    }
    // A finished sub is in the Done card (inside its opened task), not in this card; its ring and glyph are the same.
    await page.locator("#session-pane .cdash-done .dn-main").first().click();
    const done = page.locator('#session-pane .cdash-done .sx-av[data-sub="d"]');
    await expect(av(page, "d")).toHaveCount(0);
    for (const id of ["w", "a"]) await expect(av(page, id).locator(".sub-glyph")).toHaveCount(0);
    await expect(done.locator(".sub-glyph")).toHaveCount(0);
    await expect(av(page, "w").locator("svg.is-glow, svg.is-plan")).toHaveCount(1);
    await expect(av(page, "a").locator('circle[data-tone="question"]').first()).toBeVisible();
    await expect(done.locator('circle[data-tone="done"]').first()).toBeVisible();
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
    await expect(c.locator(".hc-timer")).toHaveText(/^running 0[23]:\d\d$/);
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
    await openQueued(page);
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

  // A head draws no ring (V2 priority badge): a main chat says one thing in its corner. Red when a sub
  // or the chat asks, green for the finished subs Joe has not seen, nothing while subs only work.
  async function mountClosedMain(page: Page, sessions: unknown[]): Promise<void> {
    await page.setViewportSize({ width: 1280, height: 900 });
    await mountView(page, { view: "sessions", chatView: "dashboard", invoke: invokeFor(sessions) });
    await page.locator(`#sessions-list li[data-session-id="main"]`).waitFor();
  }
  const mainHead = (page: Page) => page.locator(`#sessions-list li[data-session-id="main"]`);
  const mainNumber = (page: Page) => mainHead(page).locator(".chat-head-tag .ht-n");
  const D2 = { ...DONE, session_id: "d2", name: "More copy", pid: 110 };

  test("the main chat's head draws no ring and no number while a sub works or waits", async ({ page }) => {
    await mountClosedMain(page, [MAIN, WORK, QUEUED, PAUSED, STOPPED]);
    await expect(page.locator("#sessions-list .avatar-ring")).toHaveCount(0);
    await expect(mainNumber(page)).toHaveCount(0);
    await capture(page.locator("#sessions-list"), "sub-states-main-head-no-ring");
  });

  test("a main chat whose subs finished wears one green number counting them", async ({ page }) => {
    await mountClosedMain(page, [MAIN, DONE, D2]);
    await expect(mainNumber(page)).toHaveText("2");
    await expect(mainNumber(page)).toHaveClass(/is-green/);
    await expect(page.locator("#sessions-list .avatar-ring")).toHaveCount(0);
    await capture(page.locator("#sessions-list"), "sub-states-main-badge-green");
  });

  test("viewing the main chat clears the green number", async ({ page }) => {
    await mountClosedMain(page, [MAIN, DONE, D2]);
    await expect(mainNumber(page)).toHaveText("2");
    await mainHead(page).click();
    await page.locator("#session-pane .cdash").waitFor();
    await expect(mainNumber(page)).toHaveCount(0);
  });

  for (const [label, unfinished] of [["queued", QUEUED], ["stopped", STOPPED], ["paused", PAUSED], ["at its usage limit", LIMITED]] as const) {
    test(`one ${label} sub does not count as finished: the green number counts only the finished ones`, async ({ page }) => {
      await mountClosedMain(page, [MAIN, DONE, D2, unfinished]);
      await expect(mainNumber(page)).toHaveText("2");
      await expect(mainNumber(page)).toHaveClass(/is-green/);
    });
  }

  test("a working sub among finished ones does not stop the green number", async ({ page }) => {
    await mountClosedMain(page, [MAIN, DONE, WORK]);
    await expect(mainNumber(page)).toHaveText("1");
    await expect(mainNumber(page)).toHaveClass(/is-green/);
  });

  test("a sub that asks gives the main chat one red number, which outranks the green one", async ({ page }) => {
    await mountClosedMain(page, [MAIN, DONE, ASK]);
    await expect(mainNumber(page)).toHaveText("1");
    await expect(mainNumber(page)).toHaveClass(/is-red/);
    await expect(mainHead(page).locator(".ht-n")).toHaveCount(1);
  });

  test("a queued sub's menu leads with Start now and Drop and nests what needs a running sub", async ({ page }) => {
    await openMain(page, ALL);
    await openQueued(page);
    await avq(page, "q").click({ button: "right" });
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
    await openQueued(page);
    await avq(page, "q").click({ button: "right" });
    await page.locator(".sx-menu .smore-item", { hasText: "Start now" }).click();
    await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "start_queued_sub").length).toBe(1);
    expect((await invokeCalls(page)).find((c) => c.cmd === "start_queued_sub")!.args).toMatchObject({ sessionId: "q" });
    await openQueued(page);
    await avq(page, "q").click({ button: "right" });
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
