// Reviewed 2026-11-25 (model and effort are words, not battery glyphs; the desktop chat header is one line with one text chip): nothing this spec asserts changed, and it passes in the full view-suite run.
// Reviewed 2026-11-23 (merged Plan card): a project's main chat now draws its subs as feature lines in the Plan card and drops the Subchats and Attachments cards, so this spec turns window.__ccSubsCard on to drive the old cards; the cases below pass in the run of every dependent spec.
// Reviewed 2026-11-21 (Run card and opened sub view tabs): chat-dashboard.ts, dashboard-zones.ts, dashboard-extras.css and subs-card.ts changed for the Run card's after names and the sub view's Plan and Attachments tabs; nothing this spec asserts changed, and it passes (run of every dependent spec).
// asserts: src/views/sessions/chat-dashboard/subs-card.ts, src/views/sessions/chat-dashboard/sub-queued-popup.ts, src/views/sessions/chat-dashboard/sub-queued-popup.css, src/shared/chat/dashboard/subs-model.ts, src/shared/chat/anchored-popover.ts
import { test, expect, type Locator, type Page } from "@playwright/test";
import { fireEvent, mountView, SESSIONS_BASE_INVOKE, sessionInstance, userMsg } from "./harness";

// The Subchats card's "N queued" count and its popup (Joe, 2026-11-18: a sub the daemon holds has no
// process, so the card must not call it stuck). The count is its own chip beside the stuck wording
// and hidden at 0; clicking it opens an anchored popover that lists every queued chat in the order
// they start, what each waits for and a quiet footnote; the list patches in place as subs start.

const CWD = "C:/Projects/cv-site";
const MIN = 60_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
type Over = Parameters<typeof sessionInstance>[0];
const chat = (id: string, name: string, pid: number, over: Over = {}) => sessionInstance({ session_id: id, name, pid, cwd: CWD, ...over });
const sub = (id: string, name: string, pid: number, over: Over = {}) =>
  chat(id, name, pid, { subchat_of: "main", busy: false, awaiting: null, started_at: ago(12 * MIN), ...over });

const MAIN = chat("main", "CV redesign", 101);
const WORK = sub("sub-work", "Footer", 102, { busy: true, progress: { plan: null, state_since: ago(2 * MIN) } as never });
const STOP = sub("sub-stop", "Colours", 105, { progress: { plan: null, state_since: ago(10 * MIN) } });
// Held behind one sub, behind two, and in the writer line (place 1 starts first whatever its age).
const Q1 = sub("q1", "Contact form", 111, { started_at: ago(8 * MIN), progress: { plan: null, state_since: null, waiting_for: "waiting for Footer" } as never });
const Q2 = sub("q2", "Sitemap", 112, { started_at: ago(6 * MIN), progress: { plan: null, state_since: null, waiting_for: "waiting for Footer, Colours" } as never });
const Q3 = sub("q3", "Icons", 113, {
  started_at: ago(4 * MIN),
  progress: { plan: null, state_since: null, waiting_for: "waiting for the writer before it", queue_place: 1, queue_behind: "Footer" } as never,
});
const STARTED = (s: ReturnType<typeof sub>) => ({ ...s, busy: true, progress: { plan: null, state_since: ago(1000) } });

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
    list_subchat_cards: [], list_session_images: { images: [] }, list_previews: [],
    get_sub_brief: { brief: { task: "Build the contact form\nwith a honeypot", goal: "g", done_when: "d" } },
    start_queued_sub: null, drop_queued_sub: null, freeze_session: null, unfreeze_session: null,
  };
}

async function openMain(page: Page, sessions: unknown[], size = { width: 1280, height: 900 }): Promise<void> {
  await page.setViewportSize(size);
  await mountView(page, { view: "sessions", chatView: "dashboard", invoke: invokeFor(sessions) });
  await page.locator(`#sessions-list li[data-session-id="main"]`).click();
  await page.locator("#session-pane .cdash").waitFor();
}

/** Swaps what the next list_instances answers and tells the view the instances changed. */
async function answerWith(page: Page, next: unknown[]): Promise<void> {
  await page.evaluate((list) => {
    const w = window as unknown as { __TAURI__: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } } };
    const orig = w.__TAURI__.core.invoke;
    w.__TAURI__.core.invoke = (cmd, args) => (cmd === "list_instances" ? Promise.resolve(list) : orig(cmd, args));
  }, next);
  await fireEvent(page, "instances-changed", [null]);
}

/** Every transition that starts on the page from now on, by the target's class and property. */
async function recordTransitions(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __tr: Array<{ cls: string; prop: string }> };
    w.__tr = [];
    document.addEventListener("transitionrun", (e) => w.__tr.push({ cls: String((e.target as HTMLElement).className), prop: (e as TransitionEvent).propertyName }), true);
  });
}
const transitions = (page: Page): Promise<Array<{ cls: string; prop: string }>> =>
  page.evaluate(() => (window as unknown as { __tr: Array<{ cls: string; prop: string }> }).__tr);

const card = (page: Page) => page.locator("#session-pane .cdash-left .cdash-subs");
const chip = (page: Page) => card(page).locator(".sx-queued");
const pop = (page: Page) => page.locator(".sq-pop");
const rows = (page: Page) => pop(page).locator(".sq-row:not(.is-leaving)");
const rowIds = (loc: Locator) => loc.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.sub));
// Open and past its grow-in: a box measured mid-enter is scaled.
const settled = async (page: Page): Promise<void> => {
  await expect(pop(page)).toHaveClass(/is-open/);
  await expect(pop(page)).toHaveCSS("transform", "none");
};

test.describe("chat dashboard / Subchats card, the queued count and popup", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => { (window as unknown as { __ccSubsCard?: boolean }).__ccSubsCard = true; }); // a main chat's Plan card replaces the Subchats card by default
  });
  test("a queued sub is the 'N queued' count, apart from the stuck wording, and gets no row", async ({ page }) => {
    await openMain(page, [MAIN, WORK, STOP, Q1, Q2, Q3]);
    await expect(chip(page)).toBeVisible();
    await expect(chip(page)).toHaveText("3 queued");
    await expect(card(page).locator(".sx-counts")).toHaveText("1 working · 1 stuck or waiting · 3 queued");
    // Only the stopped sub is a stuck row; the queued ones are neither a row nor a strip avatar.
    expect(await rowIds(card(page).locator(".sx-rows .sx-item"))).toEqual(["sub-stop"]);
    await expect(card(page).locator('.sx-av[data-sub="q1"]')).toHaveCount(0);
  });

  test("the count is hidden at 0", async ({ page }) => {
    await openMain(page, [MAIN, WORK, STOP]);
    await expect(chip(page)).toBeHidden();
    await expect(card(page).locator(".sx-counts-lead")).toHaveText("1 working · 1 stuck or waiting");
  });

  test("a card of only queued subs has no words before the count", async ({ page }) => {
    await openMain(page, [MAIN, Q1]);
    await expect(chip(page)).toHaveText("1 queued");
    await expect(card(page).locator(".sx-counts-lead")).toHaveText("");
    // No separator dot hangs before the chip when nothing comes first.
    expect(await card(page).locator(".sx-queued-dot").evaluate((e) => getComputedStyle(e).opacity)).toBe("0");
  });

  test("opens an anchored popup listing each queued chat in start order with name, task and what it waits for", async ({ page }) => {
    await openMain(page, [MAIN, WORK, Q1, Q2, Q3]);
    await expect(chip(page)).toHaveAttribute("aria-expanded", "false");
    await chip(page).click();
    await settled(page);
    await expect(chip(page)).toHaveAttribute("aria-expanded", "true");
    // The writer line's place 1 first, then the held ones by when they were created.
    expect(await rowIds(rows(page))).toEqual(["q3", "q1", "q2"]);
    const q3 = rows(page).nth(0);
    await expect(q3.locator(".sx-item-name")).toHaveText("Icons");
    await expect(q3.locator(".sq-after")).toHaveText("Starts after Footer");
    // The task is the first line of the brief, fetched once, and the row keeps its height while it fades in.
    await expect(q3.locator(".sq-task")).toHaveText("Build the contact form");
    await expect(rows(page).nth(1).locator(".sq-after")).toHaveText("Starts after Footer");
    await expect(rows(page).nth(2).locator(".sq-after")).toHaveText("Starts after 2 chats");
    await expect(pop(page).locator(".sq-foot")).toHaveText("Queued chats have no process and use no memory until they start.");
    // The avatar helper draws the same dim ring and clock glyph the rest of the app uses for a queued sub.
    await expect(q3.locator(".sx-av .sub-glyph i.ph-clock")).toBeVisible();
    await expect(q3.locator('.sx-av circle[data-tone="dim"]').first()).toBeVisible();
    // A popover, not a modal: the page behind stays clickable and an outside click closes it.
    await page.locator("#session-pane .cdash-plan").first().click({ position: { x: 4, y: 4 }, force: true });
    await expect(pop(page)).toHaveCount(0);
    await expect(chip(page)).toHaveAttribute("aria-expanded", "false");
  });

  test("a click on a row does what clicking that sub does: it opens the sub's peek, and the popup closes", async ({ page }) => {
    await openMain(page, [MAIN, WORK, Q1, Q2]);
    await chip(page).click();
    await settled(page);
    await rows(page).nth(0).locator(".sx-item-name").click();
    await expect(card(page).locator('.sx-det[data-sub="q1"]')).toBeVisible();
    await expect(pop(page)).toHaveCount(0);
  });

  test("the keyboard opens it with Enter or Space, walks the rows, and Escape closes it and returns focus", async ({ page }) => {
    await openMain(page, [MAIN, WORK, Q1, Q2, Q3]);
    await chip(page).focus();
    await page.keyboard.press("Enter");
    await settled(page);
    // Focus moves to the first row, Arrow keys walk them (wrapping), Escape gives focus back to the chip.
    await expect(rows(page).nth(0).locator(".sx-av")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(rows(page).nth(1).locator(".sx-av")).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(rows(page).nth(2).locator(".sx-av")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(pop(page)).toHaveCount(0);
    await expect(chip(page)).toBeFocused();
    await expect(chip(page)).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Space");
    await settled(page);
    await expect(pop(page)).toBeVisible();
    // Enter on a focused avatar picks that sub.
    await page.keyboard.press("Enter");
    await expect(card(page).locator('.sx-det[data-sub="q3"]')).toBeVisible();
    await expect(pop(page)).toHaveCount(0);
  });

  test("a row's hover card draws above the popup, and a rewritten row keeps the keyboard focus", async ({ page }) => {
    await openMain(page, [MAIN, WORK, Q1, Q2, Q3]);
    await chip(page).click();
    await settled(page);
    await pop(page).locator('.sx-av[data-sub="q1"]').hover();
    const hoverCard = page.locator(".sx-hover-card");
    await expect(hoverCard).toBeVisible();
    const z = async (loc: Locator): Promise<number> => Number(await loc.evaluate((e) => getComputedStyle(e).zIndex));
    expect(await z(hoverCard)).toBeGreaterThan(await z(pop(page)));
    await page.mouse.move(2, 2);
    // Sitemap's holder list changes, so its row is rewritten while its avatar has the focus.
    await pop(page).locator('.sx-av[data-sub="q2"]').focus();
    const q2 = { ...Q2, progress: { plan: null, state_since: null, waiting_for: "waiting for Footer" } };
    await answerWith(page, [MAIN, WORK, Q1, q2, Q3]);
    await expect(pop(page).locator('.sq-row[data-sub="q2"] .sq-after')).toHaveText("Starts after Footer");
    await expect(pop(page).locator('.sx-av[data-sub="q2"]')).toBeFocused();
  });

  test("focus on the only row stays inside the popup when that sub starts as another is queued", async ({ page }) => {
    await openMain(page, [MAIN, WORK, Q1]);
    await chip(page).click();
    await settled(page);
    await expect(pop(page).locator('.sx-av[data-sub="q1"]')).toBeFocused();
    await answerWith(page, [MAIN, WORK, STARTED(Q1), Q2]);
    await expect(pop(page).locator('.sq-row[data-sub="q2"] .sx-av')).toBeFocused();
  });

  test("the list updates live: a sub that starts leaves with its exit, the count ticks in place and the popup does not replay its enter", async ({ page }) => {
    await openMain(page, [MAIN, WORK, Q1, Q2, Q3]);
    await chip(page).click();
    await settled(page);
    await expect(rows(page).nth(0).locator(".sq-task.is-ready")).toHaveCount(1);
    await expect(rows(page).nth(2).locator(".sq-task.is-ready")).toHaveCount(1);
    await page.waitForTimeout(250);
    await pop(page).evaluate((e) => { e.setAttribute("data-same-node", "1"); });
    const before = (await pop(page).boundingBox())!;
    await recordTransitions(page);

    await answerWith(page, [MAIN, WORK, STARTED(Q3), Q1, Q2]);
    // The count changes in place and the row folds away; the node of the popup is the same one.
    await expect(chip(page)).toHaveText("2 queued");
    await expect(pop(page)).toHaveAttribute("data-same-node", "1");
    await expect.poll(async () => rowIds(rows(page))).toEqual(["q1", "q2"]);
    await expect(pop(page).locator(".sq-row")).toHaveCount(2);
    const tr = await transitions(page);
    expect(tr.some((t) => /is-leaving/.test(t.cls) && t.prop === "grid-template-rows")).toBe(true);
    expect(tr.some((t) => /is-leaving/.test(t.cls) && t.prop === "opacity")).toBe(true);
    // The popup itself never ran its enter or exit again, and the number ticked instead of being rebuilt.
    expect(tr.filter((t) => /sq-pop/.test(t.cls))).toEqual([]);
    // The rows closed the gap: the popup is one row shorter.
    await expect.poll(async () => (await pop(page).boundingBox())!.height).toBeLessThan(before.height - 40);
    // A row that is still queued keeps its node and its loaded task.
    await expect(rows(page).nth(0).locator(".sq-task")).toHaveText("Build the contact form");

    // The last queued sub starting folds the chip out and closes the popup.
    await answerWith(page, [MAIN, WORK, STARTED(Q3), STARTED(Q1), STARTED(Q2)]);
    await expect(pop(page)).toHaveCount(0);
    await expect(chip(page)).toBeHidden();
  });

  test("a new queued sub joins the open list at its place with an enter, and the others do not move or replay", async ({ page }) => {
    await openMain(page, [MAIN, WORK, Q1]);
    await chip(page).click();
    await settled(page);
    await page.waitForTimeout(250);
    await recordTransitions(page);
    await answerWith(page, [MAIN, WORK, Q1, Q2]);
    await expect(chip(page)).toHaveText("2 queued");
    expect(await rowIds(rows(page))).toEqual(["q1", "q2"]);
    await expect(pop(page).locator(".sq-row")).toHaveCount(2);
    // The enter's transitions start on the next frame, not in the task that inserted the row.
    await expect.poll(async () => (await transitions(page)).some((t) => t.prop === "grid-template-rows")).toBe(true);
    expect((await transitions(page)).filter((t) => /sq-pop/.test(t.cls))).toEqual([]);
  });

  test("hovering a row or the count changes no box, and every control declares its transitions", async ({ page }) => {
    await openMain(page, [MAIN, WORK, Q1, Q2]);
    const chipBox = await chip(page).boundingBox();
    await chip(page).hover();
    expect(await chip(page).boundingBox()).toEqual(chipBox);
    await chip(page).click();
    await settled(page);
    const row = rows(page).nth(0);
    const popBox = await pop(page).boundingBox();
    const rowBox = await row.boundingBox();
    await row.locator(".sx-item").hover();
    expect(await row.boundingBox()).toEqual(rowBox);
    expect(await pop(page).boundingBox()).toEqual(popBox);
    const decl = (loc: Locator, prop: string) => loc.evaluate((e, p) => getComputedStyle(e).transitionProperty.split(",").map((s) => s.trim()).includes(p), prop);
    expect(await decl(pop(page), "opacity")).toBe(true);
    expect(await decl(pop(page), "transform")).toBe(true);
    expect(await decl(row, "grid-template-rows")).toBe(true);
    expect(await decl(card(page).locator(".sx-queued-wrap"), "grid-template-columns")).toBe(true);
    expect(await decl(chip(page), "background")).toBe(true);
    // A press changes the background, never the size.
    const idle = await row.locator(".sx-item").evaluate((e) => getComputedStyle(e).backgroundColor);
    await page.mouse.move(0, 0);
    await row.locator(".sx-item").hover();
    await page.mouse.down();
    expect(await row.locator(".sx-item").evaluate((e) => getComputedStyle(e).transform)).toBe("none");
    expect(await row.locator(".sx-item").evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe(idle);
    await page.mouse.up();
  });

  for (const [label, size] of [["a short window", { width: 1280, height: 420 }], ["a narrow window", { width: 520, height: 800 }]] as const) {
    test(`the popup stays inside ${label}`, async ({ page }) => {
      await openMain(page, [MAIN, WORK, Q1, Q2, Q3], size);
      await chip(page).click();
      await settled(page);
      await page.waitForTimeout(250);
      const box = (await pop(page).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width);
      expect(box.y + box.height).toBeLessThanOrEqual(size.height);
    });
  }

  test("reduced motion keeps the timing and fades instead of moving", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openMain(page, [MAIN, WORK, Q1, Q2]);
    await chip(page).click();
    await settled(page);
    await page.waitForTimeout(250);
    expect(await pop(page).evaluate((e) => getComputedStyle(e).transform)).toBe("none");
    expect(await pop(page).evaluate((e) => getComputedStyle(e).transitionDuration)).not.toMatch(/^0s/);
    await answerWith(page, [MAIN, WORK, STARTED(Q1), Q2]);
    await expect(chip(page)).toHaveText("1 queued");
    await expect(pop(page).locator(".sq-row")).toHaveCount(1);
  });
});
