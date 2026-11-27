// asserts: src/views/sessions/chat-dashboard/features-html.ts, src/views/sessions/chat-dashboard/features-card.ts, src/views/sessions/chat-dashboard/features-card.css, src/views/sessions/chat-dashboard/features-fold-popup.ts, src/shared/chat/dashboard/features-model.ts
import { test, expect, type Locator, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance, userMsg } from "./harness";

// A Plan line with many subs (Joe picked variant A, 2026-11-27): up to five chats it is the plain
// trail; above that every finished chat folds into a green +N at the front and, when the rest do not
// fit the card's width, the queued (then the working) fold whole into a +N at the end. A state is
// all icons or all in a +N, never split; asking always shows; nothing overflows at any width.

const CWD = "C:/Projects/cv-site";
const MIN = 60_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
type Over = Parameters<typeof sessionInstance>[0];
const sub = (id: string, name: string, pid: number, over: Over = {}) =>
  sessionInstance({ session_id: id, name, pid, cwd: CWD, subchat_of: "main", busy: false, awaiting: null, ...over });

const MAIN = sessionInstance({ session_id: "main", name: "Release", pid: 100, cwd: CWD });

type Mix = { done: number; working: number; asking: number; queued: number };
/** One feature (todo pc-1900): finished subs first (they started first), then working, asking, queued. */
function crowd(mix: Mix) {
  const states: string[] = [
    ...Array(mix.done).fill("done"), ...Array(mix.working).fill("working"), ...Array(mix.asking).fill("asking"), ...Array(mix.queued).fill("queued"),
  ];
  return states.map((st, i) => {
    const over: Over = { started_at: ago((states.length - i) * 5 * MIN + MIN) };
    if (st === "done") Object.assign(over, { subchat_finished: true, awaiting: "done" });
    if (st === "working") Object.assign(over, { busy: true, progress: { plan: null, state_since: ago(MIN) } });
    if (st === "asking") Object.assign(over, { awaiting: "question" });
    if (st === "queued") Object.assign(over, { started_at: null as never, progress: { plan: null, state_since: null, waiting_for: "Invite modal" } as never });
    return sub(`s${i}`, `pc-1900 chat ${i}`, 200 + i, over);
  });
}

const HISTORY = [userMsg("go")];
async function openMain(page: Page, subs: ReturnType<typeof crowd>, width: number): Promise<void> {
  const all = [MAIN, ...subs];
  await page.setViewportSize({ width, height: 900 });
  await mountView(page, {
    view: "sessions",
    chatView: "dashboard",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: all,
      get_active_sessions: all,
      list_subchats_on: ["main"],
      load_history_page: { events: HISTORY, oldest_seq: 0, newest_seq: HISTORY.length, has_more: false },
      context_status: { model: "claude-opus-5", window: 1_000_000, occupancy: 340_000, remaining: 660_000, pct_used: 34, pct_left: 66 },
      list_subchat_cards: [],
      list_session_images: { images: [] },
      get_sub_brief: { brief: { task: "Wire the contact form", goal: "Match the mock", done_when: "Tests green", kind: "build" } },
      list_previews: [],
    },
  });
  await page.locator(`#sessions-list li[data-session-id="main"]`).click();
  await page.locator("#session-pane .cdash").waitFor();
  // Every sub's stored kind (build) lands after the first draw, which redraws the lines: wait for it, so a
  // spec that opens a list never races that redraw.
  await page.waitForFunction(() => {
    const icons = [...document.querySelectorAll(".cdash-plan .pf-trail .pf-ti i")];
    return icons.length > 0 && icons.every((i) => i.classList.contains("ph-code"));
  });
}

const plan = (page: Page) => page.locator("#session-pane .cdash-plan");
const line = (page: Page) => plan(page).locator('.pf-feat[data-feat="todo:pc-1900"]');
const states = (loc: Locator) => loc.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.st ?? ""));

/** Nothing spills: the line fits its row, the trail starts inside it, and the name keeps room to read. */
async function expectFits(page: Page): Promise<void> {
  const m = await line(page).locator(".pf-row").evaluate((row) => {
    const r = row.getBoundingClientRect();
    const t = row.querySelector(".pf-trail")!.getBoundingClientRect();
    const title = row.querySelector(".pf-rmain")!.getBoundingClientRect();
    return { overflow: row.scrollWidth - row.clientWidth, trailLeft: t.left - r.left, trailRight: r.right - t.right, title: title.width };
  });
  expect(m.overflow).toBeLessThanOrEqual(0);
  expect(m.trailLeft).toBeGreaterThanOrEqual(0);
  expect(m.trailRight).toBeGreaterThanOrEqual(0);
  expect(m.title).toBeGreaterThanOrEqual(60);
}

/** The states drawn as icons and the states a +N names in its tooltip never overlap. */
async function expectNoSplit(page: Page): Promise<void> {
  const icons = new Set(await states(line(page).locator(".pf-ti")));
  const folded = new Set<string>();
  for (const tip of await line(page).locator(".pf-fold").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tip ?? ""))) {
    for (const [word, st] of [["asking", "asking"], ["working", "working"], ["queued", "queued"], ["finished", "done"]] as const) if (tip.includes(word)) folded.add(st);
  }
  for (const st of ["asking", "working", "queued", "done"]) expect(icons.has(st) && folded.has(st), `${st} is both an icon and in a +N`).toBe(false);
}

const MIXES: Record<number, Mix> = {
  3: { done: 1, working: 1, asking: 1, queued: 0 },
  6: { done: 2, working: 2, asking: 1, queued: 1 },
  12: { done: 6, working: 3, asking: 1, queued: 2 },
  20: { done: 11, working: 4, asking: 1, queued: 4 },
};

test.describe("chat dashboard / Plan line with many subs", () => {
  test("a line of three subs is today's trail: one icon each, no +N", async ({ page }) => {
    await openMain(page, crowd(MIXES[3]!), 1280);
    await expect(line(page).locator(".pf-ti")).toHaveCount(3);
    await expect(line(page).locator(".pf-fold")).toHaveCount(0);
    await expectFits(page);
  });

  for (const [width, label] of [[1920, "wide"], [1280, "desktop"], [390, "phone"], [340, "small phone"]] as const) {
    for (const n of [6, 12, 20]) {
      test(`${n} subs at ${label} width: finished fold first, no state split, asking shows, nothing overflows`, async ({ page }) => {
        await openMain(page, crowd(MIXES[n]!), width);
        const mix = MIXES[n]!;
        // The finished are one green +N at the front, newest first in its list.
        const first = line(page).locator(".pf-trail > :first-child");
        await expect(first).toHaveClass(/pf-fold/);
        await expect(first).toHaveAttribute("data-st", "done");
        await expect(first).toHaveText(`+${mix.done}`);
        expect(await states(line(page).locator(".pf-ti"))).not.toContain("done");
        // Asking always shows.
        expect(await states(line(page).locator(".pf-ti"))).toContain("asking");
        await expectNoSplit(page);
        await expectFits(page);
        // The slots hold: icons plus +N chips never pass the budget (8, 7 or 5 by the card's width).
        const cells = await line(page).locator(".pf-trail > *").count();
        const host = await line(page).evaluate((e) => (e.parentElement as HTMLElement).clientWidth);
        expect(cells).toBeLessThanOrEqual(host >= 450 ? 8 : host >= 360 ? 7 : 5);
        await capture(plan(page), `chat-dashboard-features-many-${n}-${label}`);
      });
    }
  }

  test("a +N lists its chats, a pick opens that chat in the line, a second click shuts the list", async ({ page }) => {
    await openMain(page, crowd(MIXES[20]!), 1280);
    const fold = line(page).locator('.pf-fold[data-which="done"]');
    await fold.click();
    const pop = page.locator(".pf-pop");
    await expect(pop).toBeVisible();
    await expect(pop.locator(".pf-pop-row")).toHaveCount(MIXES[20]!.done);
    await expect(pop.locator(".pf-pop-p").first()).toHaveText("Done");
    await fold.click();
    await expect(pop).toHaveCount(0);
    await fold.click();
    await pop.locator(".pf-pop-row").nth(2).click();
    await expect(pop).toHaveCount(0);
    await expect(line(page).locator(".pf-body")).toHaveCount(1);
    await expect(line(page).locator(".pf-fold.is-sel")).toHaveCount(1);
  });

  test("Escape shuts a +N's list and hands focus back to the +N", async ({ page }) => {
    await openMain(page, crowd(MIXES[12]!), 1280);
    const fold = line(page).locator('.pf-fold[data-which="done"]');
    await fold.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".pf-pop")).toBeVisible();
    await expect(page.locator(".pf-pop-row").first()).toBeFocused();
    // The popover wires Escape one timer tick after it opens (outside-dismiss.ts), and Chromium runs an input
    // event before that tick: press again until it takes.
    await expect(async () => {
      await page.keyboard.press("Escape");
      await expect(page.locator(".pf-pop")).toHaveCount(0, { timeout: 250 });
    }).toPass();
    await expect(fold).toBeFocused();
  });

  test("hovering a +N names what is inside it", async ({ page }) => {
    await openMain(page, crowd(MIXES[20]!), 1280);
    const fold = line(page).locator('.pf-fold[data-which="done"]');
    await fold.hover();
    await expect(fold).toHaveAttribute("data-tip", `${MIXES[20]!.done} finished chats`);
    await expect.poll(() => fold.evaluate((e) => getComputedStyle(e, "::after").opacity)).toBe("1");
  });
});
