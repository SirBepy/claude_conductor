// asserts: src/views/sessions/permission-modal/secret-card.ts, src/views/sessions/permission-modal/askers.ts, src/views/sessions/permission-modal/askers-strip.ts, src/views/sessions/permission-modal/index.ts, src/views/sessions/permission-modal/question-submit.ts, src/views/sessions/permission-modal/resurface.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, fireEvent, invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance, waitForPaneSettled } from "./harness";

// pc-1786: a secret request (request_secret / capture_secret_from_page / broker
// token card) is one pending card among the others. It used to take the only slot
// in the window, so no other chat's question could be seen or answered until Joe
// gave the key or cancelled. Both arrival orders, at desktop and phone width, in
// the dark and the light theme.

const SIZES = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 393, height: 852 },
} as const;

const SESSIONS = [
  sessionInstance({ session_id: "main", name: "CV redesign", pid: 101 }),
  sessionInstance({ session_id: "sub-a", name: "Review session code", pid: 102, subchat_of: "main" }),
  sessionInstance({ session_id: "sub-b", name: "Fix login test", pid: 104, subchat_of: "main" }),
  sessionInstance({ session_id: "other", name: "Other chat", pid: 103 }),
];

const SECRET = { id: "sec-1", session_id: "main", label: "Stripe key", file: "C:\\repo\\.env", key: "API_KEY" };
const QUESTION = {
  id: "q-sub", session_id: "sub-a", display_session_id: "main", seq: 1, sub_name: "Review session code",
  questions: [{ question: "Which branch?", header: "Branch", options: [{ label: "Yes" }, { label: "No" }] }],
};
// A chat of its own asking (not routed through the main chat's window).
const OTHER_QUESTION = {
  id: "q-other", session_id: "other", seq: 2,
  questions: [{ question: "Other chat asks?", header: "Other", options: [{ label: "Yes" }, { label: "No" }] }],
};

async function mount(page: Page, size: { width: number; height: number }, light: boolean, pending: Array<{ id: string }> = []): Promise<void> {
  await page.setViewportSize(size);
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      get_settings: { theme: light ? "nord-light" : "void" },
      list_instances: SESSIONS,
      get_active_sessions: SESSIONS,
      list_subchats_on: ["main"],
      list_pending_prompts: pending.map((p) => ({ id: p.id, event: "question-requested", durable: true, payload: p })),
      get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
      respond_question: false,
      respond_permission: null,
      respond_secret: true,
      send_message: null,
      confirm_question_rendered: null,
      list_auto_accept: [],
      set_auto_accept: null,
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().waitFor();
  await page.evaluate(() => document.querySelector(".view-sessions")?.setAttribute("data-mobile-pane", "list"));
  await page.locator('#sessions-list li[data-session-id="main"]').click();
  await page.locator("#session-pane .session-composer").waitFor();
  await waitForPaneSettled(page);
  if (light) await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
}

const card = (page: Page) => page.locator(".prompt-card");
const chips = (page: Page) => page.locator(".prompt-askers .prompt-asker");
const secretInput = (page: Page) => page.locator(".secret-card__input");
const title = (page: Page) => card(page).locator(".prompt-card__title");

async function calls(page: Page, cmd: string): Promise<Array<Record<string, unknown>>> {
  return (await invokeCalls(page)).filter((c) => c.cmd === cmd).map((c) => (c.args ?? {}) as Record<string, unknown>);
}

async function answerQuestionYes(page: Page): Promise<void> {
  await card(page).locator('.prompt-opt input[data-label="Yes"]').click();
  await card(page).locator(".prompt-answer-send").click();
}

for (const [sizeName, size] of Object.entries(SIZES)) {
  for (const light of [false, true]) {
    const where = `${sizeName}, ${light ? "light" : "dark"}`;

    test.describe(`view-harness / secret request among other cards (${where})`, () => {
      test("secret first: a sub's question joins it in a picker, the secret card and its typed value stay", async ({ page }) => {
        await mount(page, size, light);
        await fireEvent(page, "secret-requested", [SECRET]);
        await expect(title(page)).toContainText("Secret requested");
        await expect(chips(page)).toHaveCount(0);
        await secretInput(page).fill("sk-typed-value");

        await fireEvent(page, "question-requested", [QUESTION]);
        // Still the secret card, still one card, now with a two-chip picker.
        await expect(chips(page)).toHaveCount(2);
        await expect(card(page)).toHaveCount(1);
        await expect(title(page)).toContainText("Secret requested");
        await expect(secretInput(page)).toHaveValue("sk-typed-value");
        await expect(chips(page).filter({ has: page.locator(".ph-lock-key") })).toHaveCount(1);
        await expect(page.locator(".prompt-asker.is-active")).toHaveCount(1);
        await capture(page, `secret-first-${sizeName}-${light ? "light" : "dark"}`);

        // Joe answers the other chat's question first.
        await page.locator('.prompt-asker[data-asker="sub-a"]').click();
        await expect(card(page).locator(".prompt-panel")).toHaveCount(1);
        await answerQuestionYes(page);
        await expect.poll(async () => (await calls(page, "respond_question")).length).toBe(1);
        expect((await calls(page, "respond_question"))[0]).toMatchObject({ id: "q-sub", sessionId: "sub-a", skipped: false });
        // Nothing reached the secret: it is still waiting, and its card comes back.
        expect(await calls(page, "respond_secret")).toHaveLength(0);
        await expect(title(page)).toContainText("Secret requested");
        await expect(chips(page)).toHaveCount(0);

        // Cancel still cancels, and tells the daemon.
        await card(page).locator('[data-act="cancel"]').click();
        await expect.poll(async () => (await calls(page, "respond_secret")).length).toBe(1);
        expect((await calls(page, "respond_secret"))[0]).toMatchObject({ requestId: "sec-1", value: null, cancelled: true });
        await expect(card(page)).toHaveCount(0);
      });

      test("question first: a secret request joins it, the open question stays and the secret can wait", async ({ page }) => {
        await mount(page, size, light);
        await fireEvent(page, "question-requested", [QUESTION]);
        await expect(card(page).locator(".prompt-panel")).toHaveCount(1);
        await expect(chips(page)).toHaveCount(0);

        await fireEvent(page, "secret-requested", [SECRET]);
        await expect(chips(page)).toHaveCount(2);
        // The question Joe was on is still the card in front of him.
        await expect(card(page)).toHaveCount(1);
        await expect(card(page).locator(".prompt-panel")).toHaveCount(1);
        await expect(card(page)).toContainText("Which branch?");
        await capture(page, `question-first-${sizeName}-${light ? "light" : "dark"}`);

        // Answering the question brings the secret card up, unanswered.
        await answerQuestionYes(page);
        await expect.poll(async () => (await calls(page, "respond_question")).length).toBe(1);
        await expect(title(page)).toContainText("Secret requested");
        await expect(chips(page)).toHaveCount(0);
        expect(await calls(page, "respond_secret")).toHaveLength(0);

        // Saving sends the value to the daemon only through respond_secret.
        await secretInput(page).fill("sk-saved");
        await card(page).locator('[data-act="save"]').click();
        await expect.poll(async () => (await calls(page, "respond_secret")).length).toBe(1);
        expect((await calls(page, "respond_secret"))[0]).toMatchObject({ requestId: "sec-1", value: "sk-saved", cancelled: false });
        await expect(card(page)).toHaveCount(0);
      });

      test("the picker swaps between the secret and a question both ways, without answering either", async ({ page }) => {
        await mount(page, size, light);
        await fireEvent(page, "question-requested", [QUESTION]);
        await fireEvent(page, "secret-requested", [SECRET]);
        await expect(chips(page)).toHaveCount(2);

        await page.locator('.prompt-asker[data-asker="main"]').click();
        await expect(title(page)).toContainText("Secret requested");
        await expect(chips(page)).toHaveCount(2);
        await page.locator('.prompt-asker[data-asker="sub-a"]').click();
        await expect(card(page)).toContainText("Which branch?");
        await expect(chips(page)).toHaveCount(2);

        expect(await calls(page, "respond_secret")).toHaveLength(0);
        expect(await calls(page, "respond_question")).toHaveLength(0);
      });

      test("a secret on one chat never hides another chat's own question when Joe opens it", async ({ page }) => {
        await mount(page, size, light, [OTHER_QUESTION]);
        await fireEvent(page, "secret-requested", [SECRET]);
        await fireEvent(page, "question-requested", [OTHER_QUESTION]);
        await expect(title(page)).toContainText("Secret requested");
        // The other chat asks in its own window: opening it shows its card, secret still pending.
        await page.evaluate(() => document.querySelector(".view-sessions")?.setAttribute("data-mobile-pane", "list"));
        await page.locator('#sessions-list li[data-session-id="other"]').click();
        await expect(card(page)).toContainText("Other chat asks?");
        await answerQuestionYes(page);
        await expect.poll(async () => (await calls(page, "respond_question")).length).toBe(1);
        expect((await calls(page, "respond_question"))[0]).toMatchObject({ id: "q-other", sessionId: "other" });
        expect(await calls(page, "respond_secret")).toHaveLength(0);
        // Back on the asking chat the secret card is still waiting.
        await page.evaluate(() => document.querySelector(".view-sessions")?.setAttribute("data-mobile-pane", "list"));
        await page.locator('#sessions-list li[data-session-id="main"]').click();
        await expect(title(page)).toContainText("Secret requested");
      });
    });
  }
}

test.describe("view-harness / secret request picker motion", () => {
  test("the strip and its chips declare a transition, patch in place and never shift on hover", async ({ page }) => {
    await mount(page, SIZES.desktop, false);
    await fireEvent(page, "secret-requested", [SECRET]);
    await fireEvent(page, "question-requested", [QUESTION]);
    await expect(chips(page)).toHaveCount(2);

    const wrapTransition = await page.locator(".prompt-askers-wrap").evaluate((el) => getComputedStyle(el).transitionProperty);
    expect(wrapTransition).toContain("grid-template-rows");
    const chipTransition = await chips(page).first().evaluate((el) => getComputedStyle(el).transitionProperty);
    expect(chipTransition).toContain("background");

    // A third asker arriving patches the strip: the chips that were there keep their nodes.
    await page.locator(".prompt-asker").first().evaluate((el) => { (el as HTMLElement).dataset.probe = "kept"; });
    await fireEvent(page, "question-requested", [{ ...QUESTION, id: "q-sub-b", session_id: "sub-b", sub_name: "Fix login test", seq: 3 }]);
    await expect(chips(page)).toHaveCount(3);
    await expect(page.locator('.prompt-asker[data-probe="kept"]')).toHaveCount(1);

    // Hover changes colour only: no chip moves or resizes.
    await page.waitForTimeout(400);
    const boxes = async () => Promise.all([0, 1, 2].map((i) => chips(page).nth(i).boundingBox()));
    const before = await boxes();
    await chips(page).nth(1).hover();
    await page.waitForTimeout(250);
    expect(await boxes()).toEqual(before);
  });
});
