// asserts: src/views/sessions/permission-modal/question-ui-render.ts, src/views/sessions/permission-modal/question-ui-layout.ts
import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance, waitForPaneSettled } from "./harness";

// Joe, 2026-11-19: clicking an answer in a question card scrolled him to the
// top. A pick rebuilds the card's innerHTML (and refocuses the picked option),
// so every scroller the pick does not mean to move must come out where it went
// in: the chat transcript or dashboard body behind the card, and the card's own
// scrolling body. A pick that pages to the next question is the one deliberate
// exception for the card body: the new question starts at its top. Measured on
// the desktop composer-mode card in both chat views and on the phone width.

const SESSION = sessionInstance();

const LONG_OPTIONS = Array.from({ length: 14 }, (_, i) => ({
  label: `Option ${i + 1}`,
  description: "A fairly long description line that pads each option out so the card body has to scroll on a short card.",
}));

// A multi-select pick stays on its question; a single-select pick on a card with a
// second question pages to it.
const STAYS = [{ question: "Which features?", header: "Features", multiSelect: true, options: LONG_OPTIONS }];
const ADVANCES = [
  { question: "Which of these many options fits best?", header: "Approach", options: LONG_OPTIONS },
  { question: "Which features?", header: "Features", multiSelect: true, options: LONG_OPTIONS },
];

type ChatView = "messages" | "dashboard";

async function mountSession(page: Page, size: { width: number; height: number }, chatView: ChatView): Promise<void> {
  await page.setViewportSize(size);
  await mountView(page, {
    view: "sessions",
    chatView,
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

const scrollerSel = (chatView: ChatView): string => (chatView === "dashboard" ? ".cdash-body" : ".session-messages");

/** Gives the scroller behind the card something to scroll, then opens the card. */
async function openCard(page: Page, chatView: ChatView, questions: unknown[]): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(`#session-pane ${sel}`)!;
    const filler = document.createElement("div");
    filler.style.cssText = "height:4000px;flex:none";
    el.appendChild(filler);
  }, scrollerSel(chatView));
  await page.evaluate(async (q) => {
    const qm = await import("/views/sessions/permission-modal/index.ts");
    qm.handleQuestionRequested({ id: "q-1", session_id: "s1", questions: q as never });
  }, questions);
  await page.locator(".prompt-card").waitFor();
  await page.waitForTimeout(500);
}

interface Scrolls { chat: number; body: number }

async function readScrolls(page: Page, chatView: ChatView): Promise<Scrolls> {
  return page.evaluate((sel) => ({
    chat: document.querySelector<HTMLElement>(`#session-pane ${sel}`)!.scrollTop,
    body: document.querySelector<HTMLElement>(".prompt-card__body")!.scrollTop,
  }), scrollerSel(chatView));
}

async function scrollAll(page: Page, chatView: ChatView): Promise<Scrolls> {
  await page.evaluate((sel) => {
    document.querySelector<HTMLElement>(`#session-pane ${sel}`)!.scrollTop = 1500;
    document.querySelector<HTMLElement>(".prompt-card__body")!.scrollTop = 90;
  }, scrollerSel(chatView));
  const before = await readScrolls(page, chatView);
  // A scroller that cannot scroll would make every assert below vacuous.
  expect(before.chat).toBeGreaterThan(0);
  expect(before.body).toBeGreaterThan(0);
  return before;
}

const SURFACES: Array<{ name: string; size: { width: number; height: number }; view: ChatView }> = [
  { name: "desktop, Messages view", size: { width: 1280, height: 640 }, view: "messages" },
  { name: "desktop, Dashboard view", size: { width: 1280, height: 640 }, view: "dashboard" },
  { name: "phone width, Messages view", size: { width: 390, height: 700 }, view: "messages" },
];

for (const s of SURFACES) {
  test.describe(`view-harness / question card pick keeps scroll (${s.name})`, () => {
    test("a pick that stays on its question leaves the chat and the card body where they were", async ({ page }) => {
      await mountSession(page, s.size, s.view);
      await openCard(page, s.view, STAYS);
      const before = await scrollAll(page, s.view);

      await page.locator('.prompt-panel[data-panel="0"] .prompt-q__opts label').nth(4).click();
      await page.waitForTimeout(500);
      expect(await readScrolls(page, s.view)).toEqual(before);
    });

    test("a pick that pages to the next question leaves the chat alone and starts that question at its top", async ({ page }) => {
      await mountSession(page, s.size, s.view);
      await openCard(page, s.view, ADVANCES);
      const before = await scrollAll(page, s.view);

      await page.locator('.prompt-panel[data-panel="0"] .prompt-q__opts label').nth(4).click();
      await page.waitForTimeout(500);
      expect(await readScrolls(page, s.view)).toEqual({ chat: before.chat, body: 0 });
    });
  });
}
