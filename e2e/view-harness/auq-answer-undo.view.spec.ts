// Reviewed 2026-11-10 (stale question cards): the answer card announces itself so the dashboard leaves the question open by the message box out of Waiting on you, Skip settles its transcript card in place, a reopen swaps to the daemon prompt only when it asks the same, and Skip marks naming an old daemon id fall back to time matching; nothing this spec asserts changed, and it passes.
// asserts: src/views/sessions/permission-modal/question-submit.ts, src/shared/chat/send-grace.ts
import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";

// An answer waits out a grace window before it reaches the daemon (claude
// resumes the moment it gets one, so a sent answer cannot be taken back). The
// card stays on screen, frozen, with the composer's small Undo button laid over
// the button that was pressed; Undo gives the card back with the pick still ticked.
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
  test("Undo sits over the pressed button, and gives the card back with nothing sent", async ({ page }) => {
    await mountView(page, { invoke: { respond_question: true, send_message: null } });
    await openCard(page);

    const card = page.locator(".prompt-card");
    await card.locator('.prompt-opt input[data-label="B"]').click();
    const send = card.locator(".prompt-answer-send");
    const before = await send.boundingBox();
    await send.click();

    // The card is still there, frozen, with Undo in the place Submit was.
    await expect(card).toBeVisible();
    const undo = page.locator(".send-grace-undo");
    await expect(undo).toBeVisible();
    const over = await undo.boundingBox();
    expect(Math.abs(over!.x - before!.x)).toBeLessThan(2);
    expect(Math.abs(over!.y - before!.y)).toBeLessThan(2);
    expect(Math.abs(over!.width - before!.width)).toBeLessThan(2);
    expect(await page.evaluate(() => (document.getElementById("prompt-card-host") as HTMLElement & { inert: boolean }).inert)).toBe(true);
    expect(await respondCalls(page)).toBe(0);
    // No floating copy at the bottom of the screen any more.
    await expect(page.locator(".send-grace-floating")).toHaveCount(0);

    await undo.click();
    await expect(card).toBeVisible();
    await expect(card.locator('.prompt-opt input[data-label="B"]')).toBeChecked();
    await expect(undo).toHaveCount(0);
    expect(await page.evaluate(() => (document.getElementById("prompt-card-host") as HTMLElement & { inert: boolean }).inert)).toBe(false);

    // Past the original window: the undone answer must never fire.
    await page.waitForTimeout(GRACE_MS + 400);
    expect(await respondCalls(page)).toBe(0);

    // The card is live again: it can be answered, and that answer goes through.
    await card.locator('.prompt-opt input[data-label="A"]').click();
    await card.locator(".prompt-answer-send").click();
    await expect.poll(() => respondCalls(page), { timeout: GRACE_MS + 2000 }).toBe(1);
  });

  test("an answer left alone is delivered once the window lapses, and the card closes", async ({ page }) => {
    await mountView(page, { invoke: { respond_question: true, send_message: null } });
    await openCard(page);

    const card = page.locator(".prompt-card");
    await card.locator('.prompt-opt input[data-label="A"]').click();
    await card.locator(".prompt-answer-send").click();

    await expect(page.locator(".send-grace-undo")).toBeVisible();
    await expect(card).toBeVisible();
    expect(await respondCalls(page)).toBe(0);
    await expect.poll(() => respondCalls(page), { timeout: GRACE_MS + 2000 }).toBe(1);
    await expect(page.locator(".send-grace-undo")).toHaveCount(0);
    await expect(card).toHaveCount(0);
  });

  test("typing the next message while the card is held goes to the composer, and the Undo follows the card", async ({ page }) => {
    await mountView(page, { invoke: { respond_question: true, send_message: null } });
    await openCard(page);
    await page.evaluate(async () => {
      const relay = await import("/shared/chat/composer-stray-input.ts");
      const box = document.createElement("textarea");
      box.id = "fake-composer";
      document.body.appendChild(box);
      new relay.ComposerStrayInput({ getTextarea: () => box, isDisabled: () => false, handlePaste: () => {} }).mount();
    });

    const card = page.locator(".prompt-card");
    await card.locator('.prompt-opt input[data-label="B"]').click();
    await card.locator(".prompt-answer-send").click();
    await expect(page.locator(".send-grace-undo")).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    await page.keyboard.type("next");
    await expect(page.locator("#fake-composer")).toHaveValue("next");
    await expect(card.locator(".prompt-q__other-input")).toHaveValue("");

    // The card moves (the composer it hangs from grew): the Undo stays over its button.
    await page.evaluate(() => { document.getElementById("prompt-card-host")!.style.transform = "translateY(-40px)"; });
    await expect.poll(async () => {
      const a = await page.locator(".send-grace-undo").boundingBox();
      const b = await card.locator(".prompt-answer-send").boundingBox();
      return Math.abs(a!.y - b!.y);
    }).toBeLessThan(2);
  });

  test("an Undo reached after the frozen card was closed from outside shows the card again", async ({ page }) => {
    await mountView(page, { invoke: { respond_question: true, send_message: null } });
    await openCard(page);

    const card = page.locator(".prompt-card");
    await card.locator('.prompt-opt input[data-label="B"]').click();
    await card.locator(".prompt-answer-send").click();
    await expect(page.locator(".send-grace-undo")).toBeVisible();

    // A chat switch closes the card; the composer then carries the Undo to its
    // Send, whose Undo shortcut is undoGrace on the chat's key.
    await page.evaluate(async () => {
      const ui = await import("/views/sessions/permission-modal/question-ui.ts");
      const grace = await import("/shared/chat/send-grace.ts");
      ui.dismissQuestionCard();
      grace.undoGrace("sess-1");
    });

    await expect(card).toBeVisible();
    await page.waitForTimeout(GRACE_MS + 400);
    expect(await respondCalls(page)).toBe(0);
  });
});
