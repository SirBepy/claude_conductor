// Reviewed 2026-11-25 (model and effort are words not battery glyphs, the desktop header is one line, a Who does what row shows its model level): what this spec asserts does not depend on any of that, and it passes in the run of every spec that depends on chat-dashboard.ts.
// Reviewed 2026-11-24 (0.2.160 gate): two releases on one day now give the day's finishes to the older version, so today's finish stays under v0.2.159 after the 0.2.160 entry landed; the cases pass.
// asserts: src/views/sessions/chat-dashboard/done-lines-card.ts, src/views/sessions/chat-dashboard/done-lines-html.ts, src/views/sessions/chat-dashboard/done-lines-open.ts, src/views/sessions/chat-dashboard/done-lines-popup.ts, src/views/sessions/chat-dashboard/done-lines.css, src/views/sessions/chat-dashboard/dashboard-zones.ts, src/views/sessions/chat-dashboard/chat-dashboard.ts, src/shared/chat/dashboard/done-model.ts, src/shared/chat/dashboard/features-model.ts, src/shared/chat/dashboard/dashboard-model.ts, src/views/sessions/whats-new/whats-new.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance, userMsg } from "./harness";

// The Done card on a project's main chat: its own card below Plan, drawn from the Plan card's own
// row (same classes, so the same font), always open (no fold, no chevron), the newest three inline,
// the rest of the last day in a popup under a divider per release, a finished chat's steps under its
// row (a line with one chat opens that chat too), a line's todo and ticket icons folded away until
// the line is opened. Run in a dark and a light theme.

const CWD = "C:/Projects/cv-site";
const MIN = 60_000;
// Pinned: the popup's release dividers read the finish dates against the changelog's release dates.
const NOW = Date.parse("2026-11-23T14:00:00");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
type Over = Parameters<typeof sessionInstance>[0];
const chat = (id: string, name: string, pid: number, over: Over = {}) => sessionInstance({ session_id: id, name, pid, cwd: CWD, ...over });
const finished = (id: string, name: string, pid: number, finishedMin: number, over: Over = {}) =>
  chat(id, name, pid, {
    subchat_of: "main", subchat_finished: true, awaiting: "done", busy: false,
    started_at: ago((finishedMin + 30) * MIN), progress: { plan: null, state_since: ago(finishedMin * MIN) }, ...over,
  });

const MAIN = chat("main", "CV redesign", 101);
const WORKING = chat("sub-work", "Contact form", 102, { subchat_of: "main", busy: true, started_at: ago(10 * MIN), progress: { plan: null, state_since: ago(MIN) } });
// Newest first: the card shows the first three inline, the rest in the popup.
const FINISHED = [
  finished("f1", "pc-1811 build header", 111, 5),
  finished("f2", "sc-56709 invite modal", 112, 20),
  finished("f3", "Footer links", 113, 45),
  finished("f4", "pc-1812 review hero", 114, 3 * 60),
  finished("f5", "Pricing table", 115, 30 * 60),
  finished("f6", "pc-1811 review header", 116, 2),
];
const SESSIONS = [MAIN, WORKING, ...FINISHED];

const finish = (subId: string, ts: number, verdict: string) => ({
  id: `f-${subId}`, ts, parent_id: "main", kind: "finish", sub_id: subId, sub_name: subId, round: 1, model: "sonnet", effort: "high",
  verdict, tone: "good", text: "Text.", points: [], done: [], not_done: [], waiting_on: [], your_move: [], facts: null, sum: null, set_key: null,
});
const CARDS = [
  finish("f1", NOW - 5 * MIN, "Header built"),
  finish("f6", NOW - 2 * MIN, "Header reviewed"),
  finish("f2", NOW - 20 * MIN, "Modal done"),
  finish("f3", NOW - 45 * MIN, "Links fixed"),
  finish("f4", NOW - 180 * MIN, "Hero reviewed"),
  finish("f5", NOW - 30 * 60 * MIN, "Table done"),
];
const HISTORY = [userMsg("build the site")];

async function open(page: Page, theme = "void"): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.setViewportSize({ width: 1280, height: 900 });
  await mountView(page, {
    view: "sessions",
    chatView: "dashboard",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      get_settings: { ...((SESSIONS_BASE_INVOKE as Record<string, unknown>).get_settings as object), theme },
      list_instances: SESSIONS,
      get_active_sessions: SESSIONS,
      list_subchats_on: ["main"],
      load_history_page: { events: HISTORY, oldest_seq: 0, newest_seq: HISTORY.length, has_more: false },
      list_subchat_cards: CARDS,
      list_session_images: { images: [] },
      get_sub_brief: { brief: null },
      list_previews: [],
      context_status: { model: "claude-opus-5", window: 1_000_000, occupancy: 340_000, remaining: 660_000, pct_used: 34, pct_left: 66 },
      set_sub_pinned: null, freeze_session: null, unfreeze_session: null, cancel_turn: null, send_message: null, detach_window: null,
    },
  });
  await page.locator(`#sessions-list li[data-session-id="main"]`).click();
  await page.locator("#session-pane .cdash").waitFor();
}

const done = (page: Page) => page.locator("#session-pane .cdash .cdash-done");
const plan = (page: Page) => page.locator("#session-pane .cdash .cdash-plan");
const line = (page: Page, key: string) => done(page).locator(`.dl-feat[data-feat="${key}"]`);

for (const [theme, mode] of [["void", "dark"], ["gruvbox-light", "light"]] as const) {
  test.describe(`chat dashboard / Done card on a main chat (${mode})`, () => {
    test.beforeEach(async ({ page }) => {
      await open(page, theme);
      await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
      await expect(done(page).locator(".dl-host")).toHaveCount(1);
    });

    test("is its own card below Plan, always open, with no chevron and no toggle", async ({ page }) => {
      await expect(done(page)).toHaveClass(/cdash-card/);
      const p = await plan(page).boundingBox();
      const d = await done(page).boundingBox();
      expect(d!.y).toBeGreaterThan(p!.y);
      await expect(done(page).locator(".dl-h .cdash-h-t")).toHaveText("Done");
      // Open from the first paint: the rows are on screen and in the Tab order, nothing folds the card.
      await expect(done(page).locator(".dl-rows")).not.toHaveAttribute("inert", "");
      await expect(done(page).locator(".pf-row").first()).toBeVisible();
      await expect(done(page).locator(".dl-caret, .dl-fold, .dl-tg, [data-act='dl-toggle']")).toHaveCount(0);
      await expect(done(page).locator(".dl-h button:not(.dl-earlier)")).toHaveCount(0);
      await capture(done(page), `done-lines-always-open-${mode}`);
    });

    test("draws the newest three finished features in the Plan card's own row", async ({ page }) => {
      // Newest first: pc-1811 (its two chats, newest 2 min), sc-56709, Footer links.
      expect(await done(page).locator(".dl-feat").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.feat))).toEqual([
        "todo:pc-1811", "ticket:sc-56709", "task:footer links",
      ]);
      // Same row component and same type as the Plan card: the title's computed font matches Plan's line.
      const font = (loc: ReturnType<typeof done>) => loc.evaluate((e) => { const s = getComputedStyle(e); return [s.fontFamily, s.fontSize, s.fontWeight, s.color].join("|"); });
      await expect(done(page).locator(".pf-title").first()).toBeVisible();
      const planTitle = plan(page).locator(".pf-title").first();
      if (await planTitle.count()) expect(await font(done(page).locator(".pf-title").first())).toBe(await font(planTitle));
      // The time column says when it finished, the full date on hover; ids are icons.
      await expect(line(page, "todo:pc-1811").locator(".pf-ago")).toHaveText(/min ago|just now/);
      await expect(line(page, "todo:pc-1811").locator(".pf-when")).toHaveAttribute("data-tip", /^Finished \d+ \w+ - \d+:\d\d(AM|PM)$/);
      await expect(line(page, "todo:pc-1811").locator('.pf-lk[data-act="pf-todo"]')).toHaveCount(1);
      await expect(line(page, "ticket:sc-56709").locator(".pf-lk svg")).toHaveCount(1);
      // ...but folded away until the line is opened: invisible and out of the Tab order.
      await expect(line(page, "ticket:sc-56709").locator(".pf-ids")).toHaveCSS("visibility", "hidden");
      await expect(line(page, "ticket:sc-56709").locator(".pf-ids")).toHaveCSS("opacity", "0");
      // No chat count and no photos: one kind icon per chat.
      await expect(line(page, "todo:pc-1811").locator(".dl-trail .pf-ti")).toHaveCount(2);
      await expect(done(page).locator("img, .sx-av, .dn-n")).toHaveCount(0);
      await capture(done(page), `done-lines-open-${mode}`);
    });

    test("opening a line shows its todo and ticket icons, and a line with one chat opens that chat", async ({ page }) => {
      const f = line(page, "ticket:sc-56709");
      await f.locator(".pf-row").click();
      await expect(f.locator(".pf-ids")).toHaveCSS("visibility", "visible");
      await expect(f.locator(".pf-ids")).toHaveCSS("opacity", "1");
      await expect(f.locator(".dl-chatwrap.is-open")).toHaveCount(1);
      await expect(f.locator(".dl-chatwrap.is-open .dl-cview")).not.toHaveAttribute("inert", "");
      await capture(done(page), `done-lines-single-chat-${mode}`);
      // Closed again, the icons fold away.
      await f.locator(".pf-row").click();
      await expect(f.locator(".pf-ids")).toHaveCSS("visibility", "hidden");
    });

    test("opens a line to its chats, and a chat to its steps, one at a time", async ({ page }) => {
      const f = line(page, "todo:pc-1811");
      await f.locator(".pf-row").click();
      await expect(f).toHaveClass(/is-open/);
      await expect(f.locator(".dl-chat")).toHaveCount(2);
      await expect(f.locator(".dl-chat").first().locator(".dl-cv")).toHaveText(/Header (built|reviewed)/);
      // Cursor and colour only on a chat row: no hover background.
      await f.locator(".dl-chat").first().hover();
      await expect(f.locator(".dl-chat").first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(f.locator(".dl-chat").first()).toHaveCSS("cursor", "pointer");
      await f.locator(".dl-chat").first().click();
      await expect(f.locator(".dl-chatwrap.is-open")).toHaveCount(1);
      await f.locator(".dl-chat").nth(1).click();
      await expect(f.locator(".dl-chatwrap.is-open")).toHaveCount(1);
      await expect(f.locator(".dl-chatwrap").nth(1)).toHaveClass(/is-open/);
      // Opening a different line closes this one.
      await line(page, "ticket:sc-56709").locator(".pf-row").click();
      await expect(f).not.toHaveClass(/is-open/);
      await capture(done(page), `done-lines-chats-${mode}`);
    });

    test("nothing reflows on hover and every state change declares a transition", async ({ page }) => {
      const row = line(page, "todo:pc-1811").locator(".pf-row");
      const before = await done(page).boundingBox();
      await row.hover();
      await line(page, "ticket:sc-56709").locator(".pf-ti").first().hover();
      const after = await done(page).boundingBox();
      expect(after).toEqual(before);
      for (const sel of [".dl-slot", ".dl-det", ".dl-cview", ".pf-ids"]) {
        const t = await done(page).locator(sel).first().evaluate((e) => getComputedStyle(e).transitionDuration);
        expect(t, sel).not.toBe("0s");
      }
    });

    test("the earlier popup holds the rest, with a divider per release and a search box", async ({ page }) => {
      await done(page).locator(".dl-earlier").click();
      const pop = page.locator(".dl-pop");
      await expect(pop).toBeVisible();
      await expect(pop.locator(".dl-feat")).toHaveCount(2);
      await expect(pop.locator(".dl-ver").first()).toBeVisible();
      await pop.locator(".dl-q").fill("hero");
      await expect(pop.locator(".dl-feat")).toHaveCount(1);
      await expect(pop.locator(".pf-title")).toHaveText("Review hero");
      await pop.locator(".dl-q").fill("zzz");
      await expect(pop.locator(".dl-empty")).toBeVisible();
      await pop.locator(".dl-q").fill("");
      await capture(pop, `done-lines-popup-${mode}`);
      await page.keyboard.press("Escape");
      await expect(pop).toHaveCount(0);
    });

    test("a release divider opens that release's What's new", async ({ page }) => {
      await done(page).locator(".dl-earlier").click();
      // Today's finish is under the 0.2.159 release, yesterday's under the 0.2.158 one.
      await expect(page.locator(".dl-pop .dl-ver")).toHaveText([/v0\.2\.159/, /v0\.2\.158/]);
      await page.locator(".dl-pop button.dl-ver", { hasText: /v0\.2\.158/ }).click();
      await expect(page.locator(".dl-wn .wn-title h2")).toContainText("What's new in v0.2.158");
      await expect(page.locator(".dl-wn .wn-card").first()).toBeVisible();
      // The dialog stands alone: the popup closed, so its outside-click and Escape never see the dialog.
      await expect(page.locator(".dl-pop")).toHaveCount(0);
      await page.locator(".dl-wn .wn-title").click();
      await page.keyboard.press("Escape");
      await expect(page.locator(".dl-wn")).toHaveCount(0);
      await expect(done(page).locator(".dl-earlier")).toBeFocused();
    });

    test("a trail icon carries the same right-click chat menu as every subchat icon", async ({ page }) => {
      const icon = line(page, "ticket:sc-56709").locator(".pf-ti").first();
      await expect(icon).toHaveAttribute("data-chat-menu-id", "f2");
      await icon.click({ button: "right" });
      await expect(page.locator(".sx-menu .smore-item", { hasText: /^Open$/ })).toBeVisible();
    });
  });
}
