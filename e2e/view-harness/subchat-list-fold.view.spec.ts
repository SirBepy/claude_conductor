// asserts: src/views/sessions/sub-list.ts, src/views/sessions/main-chat.ts, src/shared/chat/dashboard/subs-model.ts
import { test, expect, type Page } from "@playwright/test";
import { assistantMsg, capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance, userMsg } from "./harness";

// A main chat with a lot of finished subs: the header list shows what is running
// plus the finished ones inside the Subchats card's hour, folds the rest behind
// "+N earlier" (expands in place), and the sidebar hover lists only what is not
// finished. Display only: no sub is closed.

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 393, height: 852 };
const CWD = "C:/Projects/cv-site";
const MIN = 60_000;

type Over = Parameters<typeof sessionInstance>[0];
const chat = (id: string, name: string, pid: number, over: Over = {}) =>
  sessionInstance({ session_id: id, name, pid, cwd: CWD, ...over });
const running = (n: number) => chat(`run-${n}`, `Running job ${n}`, 200 + n, { subchat_of: "main", busy: true, awaiting: null });
const finished = (n: number) =>
  chat(`done-${n}`, `Finished job ${n}`, 300 + n, { subchat_of: "main", busy: false, awaiting: "done", subchat_finished: true });
const finishCard = (subId: string, minutesAgo: number) => ({
  id: `finish-${subId}-1`, ts: Date.now() - minutesAgo * MIN, parent_id: "main", kind: "finish", sub_id: subId, sub_name: subId, round: 1, verdict: "Done", text: "ok",
});

// 2 running, 3 finished inside the hour, 5 finished 2 to 6 hours ago.
const SUBS = [running(1), running(2), ...[1, 2, 3, 4, 5, 6, 7, 8].map(finished)];
const CARDS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => finishCard(`done-${n}`, n <= 3 ? n * 10 : 60 * (n - 2)));

async function mount(page: Page, size: { width: number; height: number }): Promise<void> {
  const sessions = [chat("main", "CV redesign", 101), ...SUBS];
  const events = [userMsg("hello"), assistantMsg("hi")];
  await page.setViewportSize(size);
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: sessions,
      get_active_sessions: sessions,
      list_subchats_on: ["main"],
      list_subchat_cards: CARDS,
      get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
      load_history_page: { events, oldest_seq: 0, newest_seq: events.length, has_more: false },
      context_status: { model: "claude-opus-5", window: 1_000_000, occupancy: 340_000, remaining: 660_000, pct_used: 34, pct_left: 66 },
      list_slash_commands: [],
      list_auto_accept: [],
    },
  });
  await page.locator("#sessions-list li").first().waitFor();
  await page.waitForTimeout(250);
}

const rowIds = (page: Page) =>
  page.locator(".sub-list-popover .sub-row").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.subId));

async function openList(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelector(".view-sessions")?.setAttribute("data-mobile-pane", "list"));
  await page.locator('#sessions-list li[data-session-id="main"]').click();
  await expect(page.locator("#session-pane .session-header .title")).toHaveText("CV redesign");
  await page.locator("#session-pane .session-header .sub-count-btn").click();
  await page.locator(".sub-list-popover .sub-row").first().waitFor();
}

for (const [label, size] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test.describe(`view-harness / sub list fold (${label})`, () => {
    test("2 running and 8 finished list 2 + 3 rows and fold 5 under +5 earlier, which expands in place", async ({ page }) => {
      await mount(page, size);
      await openList(page);
      await expect(page.locator("#session-pane .session-header .sub-count-btn")).toContainText("10");
      expect(await rowIds(page)).toEqual(["run-1", "run-2", "done-1", "done-2", "done-3"]);
      const earlier = page.locator(".sub-list-popover [data-earlier]");
      await expect(earlier).toHaveText("+5 earlier");
      await capture(page.locator(".sub-list-popover"), `sub-list-folded-${label}`);

      await earlier.click();
      expect(await rowIds(page)).toEqual(["run-1", "run-2", "done-1", "done-2", "done-3", "done-4", "done-5", "done-6", "done-7", "done-8"]);
      await expect(earlier).toHaveText("Hide earlier");
      await capture(page.locator(".sub-list-popover"), `sub-list-expanded-${label}`);

      await earlier.click();
      expect(await rowIds(page)).toHaveLength(5);
    });
  });
}

test.describe("view-harness / sub list fold (desktop hover)", () => {
  test("the sidebar hover card lists the running subs and none of the finished ones", async ({ page }) => {
    await mount(page, DESKTOP);
    const box = (await page.locator('#sessions-list li[data-session-id="main"]').boundingBox())!;
    await page.mouse.move(box.x + 6, box.y + box.height / 2);
    const card = page.locator(".cc-row-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Running job 1");
    await expect(card).toContainText("Running job 2");
    await expect(card).not.toContainText("Finished job");
    await capture(card, "sub-hover-running-only");
  });
});
