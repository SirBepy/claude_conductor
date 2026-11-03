// asserts: src/views/sessions/permission-modal-shell.css, src/views/sessions/permission-modal-question.css, src/views/sessions/permission-modal/question-ui-render.ts, src/views/sessions/permission-modal/question-ui-answer-bar.ts
import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance, waitForPaneSettled } from "./harness";
import { shotDir } from "./shot-dir";

// Joe, 2026-11-03: an open question card replaces the chat input (one text box
// on screen; minimize to reach the chat's own), pasted images sit above the
// card's answer box instead of under the options, and minimize plays an exit.
// Mounts the real sessions view at a desktop width, so the card lands in
// --composer mode.

const DESKTOP = { width: 1280, height: 800 };
const SHOTS = shotDir();
const SESSION = sessionInstance();

const QUESTIONS = [{
  question: "Which approach fits the migration best?",
  header: "Approach",
  domain: "arch",
  options: [
    { label: "Big bang", description: "Cut over in one release." },
    { label: "Incremental", description: "Move one module at a time behind a flag." },
    { label: "Strangler", description: "Route new traffic to the new path." },
  ],
}];

async function mountDesktopSession(page: Page): Promise<void> {
  await page.setViewportSize(DESKTOP);
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
  await waitForPaneSettled(page);
}

async function openCard(page: Page): Promise<void> {
  await page.evaluate(async (q) => {
    const qm = await import("/views/sessions/permission-modal/index.ts");
    qm.handleQuestionRequested({ id: "q-1", session_id: "s1", questions: q as never });
  }, QUESTIONS);
  await page.locator(".prompt-card").waitFor();
  await page.waitForTimeout(400);
}

test.describe("view-harness / question card covers the chat input", () => {
  test("open card sits over the composer and hides it; minimize reveals it again", async ({ page }) => {
    await mountDesktopSession(page);
    await openCard(page);

    const composer = page.locator("#session-pane .session-composer");
    const card = page.locator(".prompt-card");
    const composerBox = (await composer.boundingBox())!;
    const cardBox = (await card.boundingBox())!;
    expect(cardBox.y).toBeLessThan(composerBox.y);
    expect(cardBox.y + cardBox.height).toBeGreaterThanOrEqual(composerBox.y + composerBox.height - 1);
    await expect(composer.locator(".composer-textarea:not(#prompt-card-host *)")).toBeHidden();
    await page.screenshot({ path: `${SHOTS}/auq-covers-composer-open.png` });

    await card.locator('[data-act="minimize"]').click();
    await expect(page.locator(".prompt-card--leaving")).toHaveCount(1);
    const bar = page.locator(".prompt-collapsed");
    await expect(bar).toBeVisible();
    await page.waitForTimeout(400);
    await expect(composer.locator(".composer-textarea:not(#prompt-card-host *)")).toBeVisible();
    const barBox = (await bar.boundingBox())!;
    const composerAfter = (await composer.boundingBox())!;
    expect(barBox.y + barBox.height).toBeLessThanOrEqual(composerAfter.y + 1);
    await page.screenshot({ path: `${SHOTS}/auq-covers-composer-minimized.png` });
  });

  test("a pasted image shows above the answer box without scrolling", async ({ page }) => {
    await mountDesktopSession(page);
    await openCard(page);

    await page.evaluate(() => {
      const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
      const file = new File([png], "paste.png", { type: "image/png" });
      const evt = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(evt, "clipboardData", {
        value: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }], getData: () => "" },
      });
      document.querySelector(".prompt-q__other-input")!.dispatchEvent(evt);
    });

    const thumb = page.locator(".prompt-card__answer-bar .prompt-attachments img");
    await expect(thumb).toBeVisible();
    const thumbBox = (await thumb.boundingBox())!;
    const fieldBox = (await page.locator(".prompt-q__other-input").boundingBox())!;
    expect(thumbBox.y + thumbBox.height).toBeLessThanOrEqual(fieldBox.y);
    await page.locator(".prompt-card").screenshot({ path: `${SHOTS}/auq-covers-composer-image.png` });
  });
});
