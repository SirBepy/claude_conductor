// asserts: src/views/sessions/chat-dashboard/answers-card.ts, src/views/sessions/chat-dashboard/answers-card.css
import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// The Answers card's Read more used to animate `height: 0 -> auto`, which only Chromium can
// interpolate (interpolate-size), so it snapped on the Mac build. The parts now grow between two
// measured pixel heights, which every engine interpolates. This spec runs in Chromium, which
// animated the old CSS too, so it cannot see a snap: `inlineSeen` (a px height set during the
// run) is what tells the new path from the old, and the sampled heights must pass through values
// strictly between closed and open with no pixel height left behind afterwards.

const SESSION = sessionInstance();
const CHANNEL = `chat:${SESSION.session_id}`;
const AT = 1_762_783_260;
const HISTORY = [
  { type: "user_message", content: [{ type: "text", text: "does it read the tracker?" }], timestamp: 0 },
  { type: "tool_use", tool_name: "mcp__cc_conductor__send_message", id: "a1", timestamp: AT, parent_tool_use_id: null,
    input: { kind: "answer", verdict: "It copies Shortcut's shape", tone: "good", question: "Does Trello reuse the Shortcut tracker?", text: "Trello fits the same small tracker interface with one board id.\nNo new settings page; the board id sits next to the Shortcut and Linear ids.\nThe key modal says so next to the field, and a stray tr- in prose stays plain text." } },
  { type: "tool_result", tool_use_id: "a1", output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 },
];
const EMPTY_STORE = { read: {}, threads: {}, questions: [] };

async function openChat(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 860 });
  await mountView(page, {
    view: "sessions",
    chatView: "dashboard",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      load_history_page: { events: HISTORY, oldest_seq: 0, newest_seq: HISTORY.length, has_more: false },
      answers_state: EMPTY_STORE,
      ask_list_threads: [],
      answers_mark: EMPTY_STORE,
    },
  });
  await page.locator(`#sessions-list li[data-session-id="${SESSION.session_id}"]`).click();
  await page.waitForFunction((name) => {
    const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
    return (w.__ccListeners?.get(name)?.size ?? 0) > 0;
  }, CHANNEL);
}

/** Samples the body's rendered height every frame for `ms` after the next click on Read more. */
const sampleAfterClick = (page: Page, ms: number): Promise<{ heights: number[]; inlineSeen: boolean }> =>
  page.evaluate((span) => new Promise((resolve) => {
    const body = document.querySelector<HTMLElement>(".cdash-answers .ax-face .mc-body")!;
    const heights: number[] = [];
    let inlineSeen = false;
    document.querySelector<HTMLElement>(".cdash-answers .ax-readmore")!.click();
    const t0 = performance.now();
    const tick = (): void => {
      heights.push(body.getBoundingClientRect().height);
      if (body.style.height.endsWith("px")) inlineSeen = true;
      if (performance.now() - t0 < span) requestAnimationFrame(tick);
      else resolve({ heights, inlineSeen });
    };
    requestAnimationFrame(tick);
  }), ms);

test.describe("chat dashboard / answers Read more", () => {
  test("opens and folds through measured heights, not a snap, and leaves no pixel height behind", async ({ page }) => {
    await openChat(page);
    const body = page.locator(".cdash-answers .ax-face .mc-body");
    await expect(body).toHaveCount(1);
    expect(await body.evaluate((el) => el.getBoundingClientRect().height)).toBe(0);

    const opening = await sampleAfterClick(page, 700);
    const full = opening.heights[opening.heights.length - 1]!;
    expect(full).toBeGreaterThan(30);
    expect(opening.inlineSeen).toBe(true);
    // At least two frames land strictly between closed and open: it travelled.
    expect(opening.heights.filter((h) => h > 1 && h < full - 1).length).toBeGreaterThanOrEqual(2);
    // Monotone growth: no overshoot, no flicker back to 0.
    for (let i = 1; i < opening.heights.length; i++) expect(opening.heights[i]!).toBeGreaterThanOrEqual(opening.heights[i - 1]! - 0.5);
    // Settled: the inline height is gone, so the content may grow later and the CSS owns the height.
    expect(await body.evaluate((el) => el.style.height)).toBe("");

    const folding = await sampleAfterClick(page, 700);
    expect(folding.heights.filter((h) => h > 1 && h < full - 1).length).toBeGreaterThanOrEqual(2);
    expect(folding.heights[folding.heights.length - 1]).toBe(0);
    expect(await body.evaluate((el) => el.style.height)).toBe("");
  });

  test("a toggle that arrives mid-fold picks up from the height it has", async ({ page }) => {
    await openChat(page);
    // Click, let two frames pass, measure and click again inside one page script, so a loaded
    // runner cannot stretch the gap between the two clicks past the 320ms the open takes.
    const run = await page.evaluate(() => new Promise<{ mid: number; content: number; first: number; end: number }>((resolve) => {
      const bodyEl = document.querySelector<HTMLElement>(".cdash-answers .ax-face .mc-body")!;
      const more = document.querySelector<HTMLElement>(".cdash-answers .ax-readmore")!;
      more.click();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const mid = bodyEl.getBoundingClientRect().height;
        const content = bodyEl.scrollHeight;
        more.click();
        requestAnimationFrame(() => {
          const first = bodyEl.getBoundingClientRect().height;
          setTimeout(() => resolve({ mid, content, first, end: bodyEl.getBoundingClientRect().height }), 700);
        });
      }));
    }));
    // Travelling when the second click came: a snap would already sit at the content height.
    expect(run.mid).toBeGreaterThan(1);
    expect(run.mid).toBeLessThan(run.content - 2);
    // The fold starts from where the open had got to and only goes down: never back up to the full
    // height, never a jump to 0.
    expect(run.first).toBeLessThanOrEqual(run.mid + 1);
    expect(run.first).toBeGreaterThan(1);
    expect(run.end).toBe(0);
  });

  test("the written-question line opens through grid rows on hover and clips to its text", async ({ page }) => {
    await openChat(page);
    // A probe built from the card's own markup and classes (the real line needs a message with a raw text).
    await page.evaluate(() => {
      const q = document.createElement("div");
      q.className = "ax-q0";
      q.id = "q0-probe";
      q.style.cssText = "position:fixed;top:120px;left:120px;width:320px;background:#222;padding:6px";
      q.innerHTML = 'Does Trello reuse the Shortcut tracker?<span class="ax-q0-raw"><span class="ax-q0-raw-in">You wrote: trello also uses sc?</span></span>';
      document.body.appendChild(q);
    });
    const rawH = (): Promise<number> => page.evaluate(() => document.querySelector("#q0-probe .ax-q0-raw")!.getBoundingClientRect().height);
    expect(await rawH()).toBe(0);
    await page.locator("#q0-probe").hover();
    const heights: number[] = [];
    for (let i = 0; i < 14; i++) {
      heights.push(await rawH());
      await page.waitForTimeout(40);
    }
    expect(heights.some((h) => h > 1 && h < heights[heights.length - 1]! - 1)).toBe(true);
    expect(heights[heights.length - 1]!).toBeGreaterThan(8);
    await page.mouse.move(0, 0);
    await expect.poll(rawH).toBe(0);
  });
});
