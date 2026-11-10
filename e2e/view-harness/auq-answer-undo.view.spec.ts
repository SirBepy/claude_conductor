// asserts: src/views/sessions/permission-modal/question-submit.ts, src/shared/chat/send-grace.ts
import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";

// An answer waits out a grace window behind a small Undo button before it reaches the
// daemon (claude resumes the moment it gets one, so a sent answer cannot be
// taken back). Undo brings the card back with the picked option still ticked.
// The harness turns the window off for every other spec; this one sets a real,
// short one.

const GRACE_MS = 1200;

async function openCard(page: Page): Promise<void> {
  await page.evaluate(async (ms) => {
    (globalThis as unknown as { __ccSendGraceMs: number }).__ccSendGraceMs = ms;
    const qm = await import("/views/sessions/permission-modal/index.ts");
    const sm = await import("/views/sessions/state.ts");
    const sid = "sess-1";
    sm.state.selectedId = sid;
    qm.setSelectedSessionId(sid);
    const pane = document.createElement("div");
    pane.innerHTML = '<div class="session-composer"></div>';
    document.body.appendChild(pane);
    qm.handleQuestionRequested({
      id: "q1",
      session_id: sid,
      questions: [{ question: "Q1?", header: "Q1", options: [{ label: "A" }, { label: "B" }] }],
    });
  }, GRACE_MS);
}

const respondCalls = (page: Page): Promise<number> =>
  page.evaluate(
    () => (window as unknown as { __ccInvokeCalls: Array<{ cmd: string }> }).__ccInvokeCalls
      .filter((c) => c.cmd === "respond_question").length,
  );

test.describe("view-harness / answer grace window", () => {
  test("Undo brings the card back with the pick kept, and nothing reaches the daemon", async ({ page }) => {
    await mountView(page, { invoke: { respond_question: true, send_message: null } });
    await openCard(page);

    const card = page.locator(".prompt-card");
    await card.locator('.prompt-opt input[data-label="B"]').click();
    await card.locator(".prompt-answer-send").click();

    await expect(card).toHaveCount(0);
    const undo = page.locator(".send-grace-undo");
    await expect(undo).toBeVisible();
    expect(await respondCalls(page)).toBe(0);

    await undo.click();
    await expect(card).toBeVisible();
    await expect(card.locator('.prompt-opt input[data-label="B"]')).toBeChecked();
    await expect(undo).toHaveCount(0);

    // Past the original window: the undone answer must never fire.
    await page.waitForTimeout(GRACE_MS + 400);
    expect(await respondCalls(page)).toBe(0);
  });

  test("an answer left alone is delivered once the window lapses", async ({ page }) => {
    await mountView(page, { invoke: { respond_question: true, send_message: null } });
    await openCard(page);

    const card = page.locator(".prompt-card");
    await card.locator('.prompt-opt input[data-label="A"]').click();
    await card.locator(".prompt-answer-send").click();

    await expect(page.locator(".send-grace-undo")).toBeVisible();
    expect(await respondCalls(page)).toBe(0);
    await expect.poll(() => respondCalls(page), { timeout: GRACE_MS + 2000 }).toBe(1);
    await expect(page.locator(".send-grace-undo")).toHaveCount(0);
  });
});
