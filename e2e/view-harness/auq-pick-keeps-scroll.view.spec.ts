// asserts: src/views/sessions/permission-modal/question-ui-render.ts, src/views/sessions/permission-modal/question-ui-layout.ts
import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance, waitForPaneSettled } from "./harness";

// Joe, 2026-11-19: clicking an answer in a question card scrolled him to the
// top. A pick rebuilds the card's innerHTML (and refocuses the picked option),
// so every scroller the card owns or pads must come out where it went in: the
// chat transcript or dashboard body behind it, the card's own body, and the
// active question panel. Measured on the desktop composer-mode card in both
// chat views and on the phone's fullscreen question page.

const SESSION = sessionInstance();

const LONG_OPTIONS = Array.from({ length: 14 }, (_, i) => ({
  label: `Option ${i + 1}`,
  description: "A fairly long description line that pads each option out so the question panel has to scroll on a short card.",
}));

const QUESTIONS = [
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

/** Gives the scroller behind the card something to scroll, then opens the card. */
async function openCard(page: Page, chatView: ChatView): Promise<void> {
  const scroller = chatView === "dashboard" ? ".cdash-body" : ".session-messages";
  await page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(`#session-pane ${sel}`)!;
    const filler = document.createElement("div");
    filler.dataset.testFiller = "1";
    filler.style.cssText = "height:4000px;flex:none";
    el.appendChild(filler);
  }, scroller);
  await page.evaluate(async (q) => {
    const qm = await import("/views/sessions/permission-modal/index.ts");
    qm.handleQuestionRequested({ id: "q-1", session_id: "s1", questions: q as never });
  }, QUESTIONS);
  await page.locator(".prompt-card").waitFor();
  await page.waitForTimeout(500);
}

interface Scrolls { chat: number; body: number; panel: number }

async function readScrolls(page: Page, chatView: ChatView): Promise<Scrolls> {
  const scroller = chatView === "dashboard" ? ".cdash-body" : ".session-messages";
  return page.evaluate((sel) => ({
    chat: document.querySelector<HTMLElement>(`#session-pane ${sel}`)!.scrollTop,
    body: document.querySelector<HTMLElement>(".prompt-card__body")!.scrollTop,
    panel: document.querySelector<HTMLElement>('.prompt-panel[data-panel="0"]')!.scrollTop,
  }), scroller);
}

async function scrollAll(page: Page, chatView: ChatView): Promise<void> {
  const scroller = chatView === "dashboard" ? ".cdash-body" : ".session-messages";
  await page.evaluate((sel) => {
    document.querySelector<HTMLElement>(`#session-pane ${sel}`)!.scrollTop = 1500;
    document.querySelector<HTMLElement>(".prompt-card__body")!.scrollTop = 90;
    document.querySelector<HTMLElement>('.prompt-panel[data-panel="0"]')!.scrollTop = 90;
  }, scroller);
}

const SURFACES: Array<{ name: string; size: { width: number; height: number }; view: ChatView }> = [
  { name: "desktop, Messages view", size: { width: 1280, height: 640 }, view: "messages" },
  { name: "desktop, Dashboard view", size: { width: 1280, height: 640 }, view: "dashboard" },
  { name: "phone width, Messages view", size: { width: 390, height: 700 }, view: "messages" },
];

for (const s of SURFACES) {
  test.describe(`view-harness / question card pick keeps scroll (${s.name})`, () => {
    test("clicking an option leaves the chat, card body and panel scroll where they were", async ({ page }) => {
      await mountSession(page, s.size, s.view);
      await openCard(page, s.view);
      await scrollAll(page, s.view);
      const before = await readScrolls(page, s.view);
      // A scroller that cannot scroll would make the asserts below vacuous.
      expect(before.chat).toBeGreaterThan(0);
      expect(before.body + before.panel).toBeGreaterThan(0);

      // A single-select pick also pages to the next question; panel 0 keeps its scroll.
      await page.locator('.prompt-panel[data-panel="0"] .prompt-q__opts label').nth(4).click();
      await page.waitForTimeout(500);
      expect(await readScrolls(page, s.view)).toEqual(before);
    });
  });
}
