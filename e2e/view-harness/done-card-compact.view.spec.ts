// asserts: src/views/sessions/chat-dashboard/done-card.ts, src/views/sessions/chat-dashboard/done-card.css, src/views/sessions/chat-dashboard/dashboard-zones.ts, src/views/sessions/chat-dashboard/chat-dashboard.ts, src/shared/chat/dashboard/dashboard-model.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// Joe, 2026-11-19: the Done card's compact row drops the initials avatar and the chevron, starts
// at the card's own left padding so the title keeps the freed width, and says how long ago the
// task finished ("20 min ago"). The opened row adds the avatar stack and the full date and time.
// Run in a dark and a light theme: the row's surfaces and the stack's ring read --color-surface.

const CWD = "C:/Projects/conductor";
const MIN = 60_000;
const NOW = Date.now();
const MAIN = sessionInstance({ session_id: "main", name: "App polish batch", pid: 101, cwd: CWD });
const sub = (id: string, name: string, pid: number) =>
  sessionInstance({ session_id: id, name, pid, cwd: CWD, subchat_of: "main", subchat_finished: true, awaiting: "done", busy: false, started_at: "2026-11-17T08:00:00Z" });

// A long title: the old row truncated it because the chevron, the avatar stack and a long date took its width.
const SUBS = [
  sub("s-long", "perf-a-no-redundant-launches-on-startup", 102),
  sub("s-hr", "asset-proposal", 103),
  sub("s-day", "asset-import-plan", 104),
];
const finish = (subId: string, ts: number, verdict: string) => ({
  id: `f-${subId}`, ts, parent_id: "main", kind: "finish", sub_id: subId, sub_name: subId, round: 1, model: "sonnet", effort: "high",
  verdict, tone: "good", text: "Text.", points: [], done: [], not_done: [], waiting_on: [], your_move: [], facts: null, sum: null, set_key: null,
});
const CARDS = [
  finish("s-long", NOW - 20 * MIN, "Done"),
  finish("s-hr", NOW - 3 * 60 * MIN, "Done"),
  finish("s-day", NOW - 26 * 60 * MIN, "Done"),
];
const HISTORY = [
  { type: "user_message", content: [{ type: "text", text: "go" }], timestamp: NOW - 30 * MIN, remote_echo: false, is_meta: false, author_session_id: null },
];

async function open(page: Page, theme: string): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mountView(page, {
    view: "sessions",
    chatView: "dashboard",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      get_settings: { ...((SESSIONS_BASE_INVOKE as Record<string, unknown>).get_settings as object), theme },
      list_instances: [MAIN, ...SUBS],
      get_active_sessions: [MAIN, ...SUBS],
      list_subchats_on: ["main"],
      load_history_page: { events: HISTORY, oldest_seq: 10, newest_seq: 11, has_more: false },
      list_subchat_cards: CARDS,
      list_session_images: { images: [] },
      get_sub_brief: { brief: null },
      list_previews: [],
      context_status: { model: "claude-sonnet-4-6", window: 1_000_000, occupancy: 340_000, remaining: 660_000, pct_used: 34, pct_left: 66 },
      clear_session: false,
    },
  });
  await page.locator(`#sessions-list li[data-session-id="main"]`).click();
}

const done = (page: Page) => page.locator("#session-pane .cdash .cdash-done");
const task = (page: Page, title: string | RegExp) => done(page).locator(".dn-task").filter({ has: page.locator(".dn-title", { hasText: typeof title === "string" ? new RegExp(`^${title}$`) : title }) });
const LONG_ROW = /^Perf a no redundant/;

for (const [theme, mode] of [["void", "dark"], ["gruvbox-light", "light"]] as const) {
  test.describe(`done card compact row (${mode})`, () => {
    test.beforeEach(async ({ page }) => {
      await open(page, theme);
      await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
      await expect(done(page).locator(".dn-task")).toHaveCount(3);
    });

    test("a compact row has no avatar, no chevron and no chat count", async ({ page }) => {
      await capture(done(page), `done-card-compact-${mode}`);
      await expect(done(page).locator(".dn-avs, .dn-avs-i, .sx-av, .sx-face")).toHaveCount(0);
      await expect(done(page).locator(".dn-chev, .ph-caret-right")).toHaveCount(0);
      await expect(done(page).locator(".dn-n")).toHaveCount(0);
      await expect(done(page).locator(".dn-det")).toHaveCount(0);
    });

    test("the tick starts at the card's left padding and the title takes the freed width", async ({ page }) => {
      const t = task(page, LONG_ROW);
      const card = (await done(page).boundingBox())!;
      const tick = (await t.locator(".dn-tick").boundingBox())!;
      // Card border 1px + padding 12px: the tick is flush with the card's own content edge.
      expect(Math.abs(tick.x - (card.x + 13))).toBeLessThanOrEqual(1);
      const title = t.locator(".dn-title");
      const box = (await title.boundingBox())!;
      const at = (await t.locator(".dn-at").boundingBox())!;
      // Nothing sits between the title and the time but the row's gap.
      expect(at.x - (box.x + box.width)).toBeLessThanOrEqual(9);
      // The title that the avatar stack and the long date used to cut off now fits whole.
      expect(await title.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      // Everything the row costs besides the title is the tick, the time column and the gaps: the
      // old row also paid a chevron and an avatar stack (about 100px more).
      const row = (await t.locator(".dn-row").boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(row.width - 110);
    });

    test("the time reads how long ago, in a tabular column that reserves one width for every row", async ({ page }) => {
      await expect(task(page, LONG_ROW).locator(".dn-at")).toHaveText("20 min ago");
      await expect(task(page, "Asset proposal").locator(".dn-at")).toHaveText("3 hr ago");
      await expect(task(page, "Asset import plan").locator(".dn-at")).toHaveText("1 d ago");
      expect(await done(page).locator(".dn-at").first().evaluate((el) => getComputedStyle(el).fontVariantNumeric)).toContain("tabular-nums");
      const rights = await done(page).locator(".dn-at").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().right)));
      expect(new Set(rights).size).toBe(1);
    });

    test("the whole row opens it, with Enter and Space too, and shows the avatar and the full date", async ({ page }) => {
      const t = task(page, "Asset proposal");
      const main = t.locator(".dn-main");
      await expect(main).toHaveAttribute("aria-expanded", "false");
      // A click on the time (far from the title) is a click on the row.
      await t.locator(".dn-at").click({ force: true });
      await expect(main).toHaveAttribute("aria-expanded", "true");
      await expect(t.locator(".dn-meta .dn-avs .sx-av")).toHaveCount(1);
      await expect(t.locator(".dn-meta .dn-n")).toHaveText("1 chat");
      await expect(t.locator(".dn-meta .dn-full")).toHaveText(/\d{1,2}:\d{2}/);
      await capture(done(page), `done-card-expanded-${mode}`);
      // Enter folds it again (the row's button keeps focus across the redraw), Space opens it.
      await main.focus();
      await page.keyboard.press("Enter");
      await expect(t.locator(".dn-det")).toHaveCount(0);
      await page.keyboard.press("Space");
      await expect(t.locator(".dn-det")).toHaveCount(1);
    });

    test("the row has a hover, a press and a focus-visible state, and a hover moves no box", async ({ page }) => {
      const t = task(page, "Asset proposal");
      const row = t.locator(".dn-row");
      await page.mouse.move(0, 0);
      const bg = () => row.evaluate((el) => getComputedStyle(el).backgroundColor);
      const rest = await bg();
      const before = await row.boundingBox();
      await row.hover();
      await expect.poll(bg).not.toBe(rest);
      expect(await row.boundingBox()).toEqual(before);
      const hovered = await bg();
      await page.mouse.down();
      await expect.poll(bg).not.toBe(hovered);
      await page.mouse.up();
      await page.mouse.move(0, 0);
      await t.locator(".dn-main").focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(row).toHaveCSS("outline-style", "solid");
    });
  });
}

test("the age text patches in place on the card's tick: same node, no animation, no redraw", async ({ page }) => {
  await page.clock.install({ time: NOW });
  await open(page, "void");
  const t = task(page, "Asset proposal");
  const at = t.locator(".dn-at");
  await expect(at).toHaveText("3 hr ago");
  await page.evaluate(() => {
    const w = window as unknown as { __runs: string[]; __row: Element | null };
    w.__runs = [];
    w.__row = document.querySelector(".cdash-done .dn-task");
    document.addEventListener("transitionrun", (e) => { if ((e.target as Element).closest(".dn-list")) w.__runs.push((e.target as Element).className.toString()); }, true);
    document.querySelector(".cdash-done .dn-at")!.setAttribute("data-probe", "1");
  });
  await page.clock.fastForward(2 * 60 * MIN);
  await expect(at).toHaveText("5 hr ago");
  // The very row element survived (a redraw would have replaced it) and nothing transitioned.
  expect(await page.evaluate(() => (window as unknown as { __row: Element }).__row.isConnected)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { __runs: string[] }).__runs)).toEqual([]);
  // A task whose label did not cross a unit keeps its text.
  await expect(done(page).locator(".dn-at[data-probe]")).toHaveCount(1);
});
