// asserts: src/views/sessions/chat-dashboard/done-card.ts, src/views/sessions/chat-dashboard/done-card.css
import { test, expect, type Locator, type Page } from "@playwright/test";
import { capture, fireEvent, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// The Done card's polish bar (ui-polish.md): the Dismiss x overlays the row and takes no space,
// a row opens by growing a grid (0fr -> 1fr) with its chats fading in 40ms apart, the chats of a
// task are an avatar stack (3, then +N) in the opened row only, and a redraw that changes nothing
// plays nothing.

const CWD = "C:/Projects/conductor";
const MIN = 60_000;
const NOW = Date.now();
const MAIN = sessionInstance({ session_id: "main", name: "App polish batch", pid: 101, cwd: CWD });
const sub = (id: string, name: string, pid: number, startedAt = "2026-11-17T08:00:00Z") =>
  sessionInstance({ session_id: id, name, pid, cwd: CWD, subchat_of: "main", subchat_finished: true, awaiting: "done", busy: false, started_at: startedAt });

// pc-0031 took five chats (a stack of 3 and "+2"), pc-0032 two, the last stands alone.
const SUBS = [
  ...[1, 2, 3, 4, 5].map((n) => sub(`big-${n}`, `pc-0031-step-${n}`, 110 + n, `2026-11-17T0${n}:00:00Z`)),
  sub("two-a", "pc-0032-build", 120, "2026-11-17T06:00:00Z"),
  sub("two-b", "pc-0032-review", 121, "2026-11-17T07:00:00Z"),
  sub("solo", "why-slow", 122),
];

const finish = (subId: string, ts: number, verdict: string) => ({
  id: `f-${subId}`, ts, parent_id: "main", kind: "finish", sub_id: subId, sub_name: subId, round: 1, model: "sonnet", effort: "high",
  verdict, tone: "good", text: "Text.", points: [], done: [], not_done: [], waiting_on: [], your_move: [], facts: null, sum: null, set_key: null,
});
const CARDS = SUBS.map((s, i) => finish(s.session_id, NOW - (i + 1) * MIN, `Finished ${s.session_id}`));

const HISTORY = [
  { type: "user_message", content: [{ type: "text", text: "go" }], timestamp: NOW - 30 * MIN, remote_echo: false, is_meta: false, author_session_id: null },
];

async function openMain(page: Page, subs = SUBS, cards: unknown[] = CARDS): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => { (window as unknown as { __ccSubsCard?: boolean }).__ccSubsCard = true; }); // a main chat's Done card is its feature lines by default, and this spec drives the per-task card
  await mountView(page, {
    view: "sessions",
    chatView: "dashboard",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [MAIN, ...subs],
      get_active_sessions: [MAIN, ...subs],
      list_subchats_on: ["main"],
      load_history_page: { events: HISTORY, oldest_seq: 10, newest_seq: 11, has_more: false },
      list_subchat_cards: cards,
      list_session_images: { images: [] },
      get_sub_brief: { brief: null },
      list_previews: [],
      context_status: { model: "claude-sonnet-4-6", window: 1_000_000, occupancy: 340_000, remaining: 660_000, pct_used: 34, pct_left: 66 },
      clear_session: false,
    },
  });
  await page.locator(`#sessions-list li[data-session-id="main"]`).click();
}

/** Starts recording every CSS transition that starts inside the Done list (target classes + property). */
const watchRuns = (page: Page): Promise<void> => page.evaluate(() => {
  const w = window as unknown as { __runs?: Array<{ cls: string; prop: string }> };
  w.__runs = [];
  document.addEventListener("transitionrun", (e) => {
    const el = e.target as Element;
    if (el.closest(".dn-list")) w.__runs!.push({ cls: el.className.toString(), prop: e.propertyName });
  }, true);
});
const runs = (page: Page): Promise<Array<{ cls: string; prop: string }>> =>
  page.evaluate(() => (window as unknown as { __runs: Array<{ cls: string; prop: string }> }).__runs.slice());

const done = (page: Page) => page.locator("#session-pane .cdash .cdash-done");
const task = (page: Page, title: string) => done(page).locator(".dn-task").filter({ has: page.locator(".dn-title", { hasText: new RegExp(`^${title}$`) }) });

/** The boxes of every part of a row, as the layout has them right now. */
const boxes = (row: Locator) => row.evaluate((el) => {
  const pick = (sel: string): number[] => {
    const n = el.querySelector(sel);
    if (!n) return [];
    const r = n.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100);
  };
  return { row: pick(":scope"), main: pick(".dn-main"), title: pick(".dn-title"), tick: pick(".dn-tick"), at: pick(".dn-at") };
});

test.describe("chat dashboard / done card polish", () => {
  test("the x overlays the row's right end and a hover changes no box in the row", async ({ page }) => {
    await openMain(page);
    const t = task(page, "Why slow");
    const row = t.locator(".dn-row");
    await page.mouse.move(0, 0);
    // The dashboard settles for a moment after it mounts (chips and cards arrive): measure once it holds still.
    let rest = await boxes(row);
    await expect.poll(async () => {
      const again = await boxes(row);
      const same = JSON.stringify(again) === JSON.stringify(rest);
      rest = again;
      return same;
    }, { intervals: [250] }).toBe(true);
    const x = t.locator(".dn-x");
    // At rest the x is invisible, takes no click and overlays the row (absolute), so it reserved nothing.
    expect(await x.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
    expect(await x.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
    expect(await x.evaluate((el) => getComputedStyle(el).position)).toBe("absolute");
    // The time sits flush with the row's padding edge: the right end of the row is not indented by the x.
    const rowBox = (await row.boundingBox())!;
    const atBox = (await t.locator(".dn-at").boundingBox())!;
    expect(rowBox.x + rowBox.width - (atBox.x + atBox.width)).toBeLessThanOrEqual(8);

    await row.hover();
    await expect.poll(() => x.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    await page.waitForTimeout(250);
    expect(await boxes(row)).toEqual(rest);
    // The x sits inside the row's right end, over the time.
    const xBox = (await x.boundingBox())!;
    expect(xBox.x + xBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
    expect(xBox.x).toBeGreaterThan(rowBox.x + rowBox.width - 40);
  });

  test("keyboard focus in a row shows the x too", async ({ page }) => {
    await openMain(page);
    const t = task(page, "Why slow");
    await page.mouse.move(0, 0);
    await t.locator(".dn-main").focus();
    await expect.poll(() => t.locator(".dn-x").evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    expect(await t.locator(".dn-x").evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("auto");
  });

  test("the chats of a task are an avatar stack in the opened row only: 3 faces then +N, and the row's boxes do not move on hover", async ({ page }) => {
    await openMain(page);
    const big = done(page).locator(".dn-task[data-task='todo:pc-0031']");
    const two = done(page).locator(".dn-task[data-task='todo:pc-0032']");
    const solo = task(page, "Why slow");
    // A compact row draws no avatar and no count.
    await expect(done(page).locator(".dn-avs, .dn-n")).toHaveCount(0);
    // One row is open at a time: opening the next folds the last.
    await big.locator(".dn-main").click();
    await expect(big.locator(".dn-meta .dn-avs .sx-av")).toHaveCount(3);
    await expect(big.locator(".dn-avs-more")).toHaveText("+2");
    await expect(big.locator(".dn-n")).toHaveText("5 chats");
    await two.locator(".dn-main").click();
    await expect(two.locator(".dn-meta .dn-avs .sx-av")).toHaveCount(2);
    await expect(two.locator(".dn-avs-more")).toHaveCount(0);
    await solo.locator(".dn-main").click();
    await expect(solo.locator(".dn-meta .dn-avs .sx-av")).toHaveCount(1);
    await expect(solo.locator(".dn-n")).toHaveText("1 chat");
    // The full date and time sits beside the stack.
    await expect(solo.locator(".dn-meta .dn-full")).toHaveText(/\d{1,2}:\d{2}/);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(400);
    const restBoxes = await boxes(big.locator(".dn-row"));
    await big.locator(".dn-row").hover();
    await page.waitForTimeout(250);
    expect(await boxes(big.locator(".dn-row"))).toEqual(restBoxes);
    await capture(done(page), "done-card-stack");
  });

  test("a row opens by growing a grid with the chats fading in 40ms apart, and folds the same way", async ({ page }) => {
    await openMain(page);
    const t = done(page).locator(".dn-task[data-task='todo:pc-0031']");
    await watchRuns(page);
    await t.locator(".dn-main").click();
    const det = t.locator(".dn-det");
    await expect(det).toHaveCount(1);
    // The expanding element declares the transition (and it is the one the fold runs on).
    const decl = await det.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { props: cs.transitionProperty, dur: cs.transitionDuration, disp: cs.display };
    });
    expect(decl.props).toContain("grid-template-rows");
    expect(decl.disp).toBe("grid");
    // It really runs: the opening started a grid-rows transition on the details and a fade on the chats.
    const opened = await runs(page);
    expect(opened.some((r) => /\bdn-det\b/.test(r.cls) && r.prop === "grid-template-rows")).toBe(true);
    expect(opened.filter((r) => /\bdn-sub\b/.test(r.cls) && r.prop === "opacity").length).toBe(5);
    expect(opened.some((r) => /\bdn-meta\b/.test(r.cls) && r.prop === "opacity")).toBe(true);
    // The chats fade in one after another: later children carry a longer delay.
    const delays = await t.locator(".dn-sub").evaluateAll((els) => els.map((e) => parseFloat(getComputedStyle(e).transitionDelay)));
    expect(delays.length).toBe(5);
    expect(Math.round(delays[1]! * 1000) - Math.round(delays[0]! * 1000)).toBe(40);
    // Folding keeps the details until the transition has run, then drops them.
    await page.evaluate(() => ((window as unknown as { __runs: unknown[] }).__runs.length = 0));
    await t.locator(".dn-main").click();
    // The folded details are kept as a ghost that folds shut (a grid-rows transition), then goes.
    await expect(t.locator(".dn-det")).toHaveCount(0);
    const folded = await runs(page);
    expect(folded.some((r) => /\bdn-det-ghost\b/.test(r.cls) && r.prop === "grid-template-rows")).toBe(true);
    await expect(t.locator(".dn-det-ghost, .dn-det")).toHaveCount(0);
  });

  test("a click leaves no x or spread behind once the mouse has moved off the row", async ({ page }) => {
    await openMain(page);
    const t = done(page).locator(".dn-task[data-task='todo:pc-0031']");
    await t.locator(".dn-main").click();
    await expect(t.locator(".dn-det")).toHaveCount(1);
    await page.mouse.move(0, 0);
    // The row keeps the pointer-focused button, but a pointer focus is no reason to show the x.
    await expect.poll(() => t.locator(".dn-x").evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
    expect(await t.locator(".dn-x").evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
  });

  test("a task with a context warning keeps its tooltip reachable above the stretched click area", async ({ page }) => {
    await openMain(page);
    const probe = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>(".cdash-done .dn-main");
      if (!main) return null;
      const warn = document.createElement("span");
      warn.className = "dn-warn";
      main.appendChild(warn);
      const cs = getComputedStyle(warn);
      const out = { position: cs.position, z: cs.zIndex };
      warn.remove();
      return out;
    });
    expect(probe).toEqual({ position: "relative", z: "1" });
  });

  test("an open row keeps still while the dashboard redraws with nothing changed", async ({ page }) => {
    await openMain(page);
    const t = task(page, "Why slow");
    await t.locator(".dn-main").click();
    await expect(t.locator(".dn-sub")).toHaveCount(1);
    // The pointer is off the row: a redraw under a resting pointer replays its hover fade (the new
    // nodes meet the pointer afresh), which is a hover transition, not the row's motion.
    await page.mouse.move(0, 0);
    await page.waitForTimeout(500);
    await watchRuns(page);
    // A newer finish card for the open chat changes the Done HTML (its verdict line) while the
    // open state stays: the redraw must happen, and play nothing.
    await fireEvent(page, "subchat-card", [{ session_id: "main", card: { ...finish("solo", Date.now() + 5000, "Again, with a new verdict"), id: "f-solo-2" } }]);
    await expect(t.locator(".dn-sub .dn-line")).toHaveText("Again, with a new verdict");
    await page.waitForTimeout(150);
    expect(await runs(page)).toEqual([]);
    await expect(t.locator(".dn-det.is-shut, .is-ghost")).toHaveCount(0);
    await expect(t.locator(".dn-sub")).toHaveCount(1);
  });

  test("a dismissed row slides away at once and its neighbours close the gap", async ({ page }) => {
    await openMain(page);
    const t = task(page, "Why slow");
    const next = done(page).locator(".dn-task").first();
    await t.hover();
    await page.waitForTimeout(250);
    await watchRuns(page);
    await t.locator(".dn-x").click();
    // The exit is a transition on the row itself (opacity and grid rows), not a snap.
    await expect.poll(async () => (await runs(page)).filter((r) => /\bdn-task\b/.test(r.cls) && /\bis-leaving\b/.test(r.cls) && (r.prop === "opacity" || r.prop === "grid-template-rows")).length).toBeGreaterThanOrEqual(2);
    await expect(t).toHaveCount(0, { timeout: 900 });
    await expect(next).toBeVisible();
  });
});
