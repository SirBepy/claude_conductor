import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// Joe, 2026-09-04, from two phone screenshots: the AUQ footer split 2 + 1
// (flex-wrap stranded Submit alone on line two), and the FAB parked on the
// composer's Send split, winning the hit test at z-index 30. Both are
// geometry, so both get measured here rather than screenshotted.

const PHONE = { width: 393, height: 852 };

const SESSION = sessionInstance();

async function mountPhoneSession(page: Page): Promise<void> {
  await page.setViewportSize(PHONE);
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().waitFor();
  await page.locator("#sessions-list li[data-session-id='s1']").click();
  await page.locator("#session-pane .session-composer").waitFor();
}

const QUESTION = [{
  question: "Do you want the live screenshot before I close?",
  header: "Close",
  options: [
    { label: "Close anyway", description: "The item gets filed as a todo so it is not lost." },
    { label: "Screenshot first", description: "Stage a held message and capture the real state." },
  ],
}];

async function openQuestionCard(page: Page): Promise<void> {
  await page.evaluate(async (q) => {
    const qm = await import("/views/sessions/permission-modal/index.ts");
    qm.handleQuestionRequested({ id: "q-1", session_id: "s1", questions: q as never });
  }, QUESTION);
  await page.locator(".prompt-card").waitFor();
  await page.locator(".prompt-card__answer-bar .prompt-q__other-input").waitFor();
  await page.waitForTimeout(250); // settle the card's 0.22s entrance transition
}

test.describe("view-harness / phone footer + FAB clearance", () => {
  test("answer bar owns its own row and both buttons share the next one", async ({ page }) => {
    await mountPhoneSession(page);
    await openQuestionCard(page);

    const footer = page.locator(".prompt-card__footer");
    const bar = (await footer.locator(".prompt-card__answer-bar").boundingBox())!;
    const skip = (await footer.locator('[data-act="cancel"]').boundingBox())!;
    const submit = (await footer.locator('[data-act="primary"]').boundingBox())!;

    // Row one is the bar alone: neither button starts before it ends.
    expect(skip.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
    expect(submit.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
    // Row two holds both, level with each other.
    expect(Math.abs(skip.y - submit.y)).toBeLessThanOrEqual(1);
    // 1:2, Joe's pick over 50/50: a chosen proportion rather than the rendered
    // width of the word "Skip", with Submit still visibly the primary.
    expect(submit.width / skip.width).toBeGreaterThan(1.9);
    expect(submit.width / skip.width).toBeLessThan(2.1);
  });

  test("the bar spans the footer's full inner width", async ({ page }) => {
    await mountPhoneSession(page);
    await openQuestionCard(page);

    const footer = (await page.locator(".prompt-card__footer").boundingBox())!;
    const bar = (await page.locator(".prompt-card__answer-bar").boundingBox())!;
    const skip = (await page.locator('.prompt-card__footer [data-act="cancel"]').boundingBox())!;
    const submit = (await page.locator('.prompt-card__footer [data-act="primary"]').boundingBox())!;

    // 14px of footer padding each side, so the bar is the row, not a column of it.
    expect(bar.width).toBeGreaterThan(footer.width - 32);
    // The button row fills the same span, which is what stops Submit floating
    // in an otherwise empty line.
    expect(submit.x + submit.width - skip.x).toBeGreaterThan(footer.width - 32);
  });

  // The fullscreen card is z-index 20 against this host's 30, so the FAB
  // painted over its Submit button - visible in the very shot taken to prove
  // the footer fix.
  test("the FAB is gone entirely while a question card is up", async ({ page }) => {
    await mountPhoneSession(page);
    await expect(page.locator(".fab-dial-fab")).toBeVisible();
    await openQuestionCard(page);
    await expect(page.locator(".fab-dial-fab")).toBeHidden();
  });

  test("the FAB clears the composer instead of sitting on Send", async ({ page }) => {
    await mountPhoneSession(page);

    const fab = page.locator(".fab-dial-fab");
    await expect(fab).toBeVisible();
    const fabBox = (await fab.boundingBox())!;
    const shellBox = (await page.locator(".composer-shell").boundingBox())!;
    const sendBox = (await page.locator(".composer-send").boundingBox())!;

    // Horizontally they still share the pane's right edge, which is why the
    // vertical clearance is the whole fix.
    expect(fabBox.x + fabBox.width).toBeGreaterThan(shellBox.x);
    expect(fabBox.y + fabBox.height).toBeLessThanOrEqual(shellBox.y);
    expect(fabBox.y + fabBox.height).toBeLessThanOrEqual(sendBox.y);
  });

  // Send's own centre was never stolen - the FAB only covered the split's
  // right end - so probing Send would pass with or without the lift. The
  // schedule chevron is the control that actually became unreachable.
  test("the tap at the schedule chevron's centre reaches the chevron", async ({ page }) => {
    await mountPhoneSession(page);

    const chevBox = (await page.locator(".composer-send-chevron").boundingBox())!;
    const hit = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (el?.closest(".fab-dial-fab")) return "fab";
      if (el?.closest(".composer-send-chevron")) return "chevron";
      return el?.className ?? "none";
    }, { x: chevBox.x + chevBox.width / 2, y: chevBox.y + chevBox.height / 2 });
    expect(hit).toBe("chevron");
  });
});
