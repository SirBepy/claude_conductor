// asserts: src/styles/base.css, src/views/sessions/permission-modal-shell.css, src/views/sessions/permission-modal-question.css
import { test, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance, waitForPaneSettled } from "./harness";
import { expectIconButtonsCentred } from "./icon-centering";

// Every icon-only button on the busiest surface (sidebar, chat header,
// composer, an open question card with a domain chip) keeps its glyph centred,
// on desktop and phone. A sweep rather than a per-button check, so a new
// surface rule that breaks centring on any button fails here first.

const SESSION = sessionInstance();

const QUESTION = [{
  question: "Which cache layer should hold the session index?",
  header: "Cache",
  domain: "tooling",
  options: [
    { label: "Memory", description: "Fast, lost on restart." },
    { label: "Disk", description: "Survives restart." },
  ],
}];

async function openChatWithCard(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      ask_list_threads: [],
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
    },
  });
  await page.locator("#sessions-list li[data-session-id='s1']").click();
  await page.locator("#session-pane .session-composer").waitFor();
  await waitForPaneSettled(page);
  await page.evaluate(async (q) => {
    const qm = await import("/views/sessions/permission-modal/index.ts");
    qm.handleQuestionRequested({ id: "q-1", session_id: "s1", questions: q as never });
  }, QUESTION);
  await page.locator(".prompt-card").waitFor();
  await page.locator('.prompt-card [data-act="ask-inline"]').waitFor();
}

test("desktop: every icon-only button has its glyph centred", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openChatWithCard(page);
  await expectIconButtonsCentred(page);
});

test("phone: every icon-only button has its glyph centred", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openChatWithCard(page);
  await expectIconButtonsCentred(page);
});

// The other top-level routes, booted on the shared seed: no per-view data, so
// this covers each view's chrome (headers, toolbars, empty states).
const ROUTES = [
  "dashboard", "schedule", "characters", "skills",
  "settings", "settings-accounts", "settings-appearance", "settings-permissions",
  "settings-power", "settings-remote-access", "settings-shortcuts",
];
const VIEWPORTS = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 } };

for (const [device, size] of Object.entries(VIEWPORTS)) {
  for (const view of ROUTES) {
    test(`${device} ${view}: every icon-only button has its glyph centred`, async ({ page }) => {
      await page.setViewportSize(size);
      await mountView(page, { view, invoke: SESSIONS_BASE_INVOKE });
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(300);
      await expectIconButtonsCentred(page);
    });
  }
}
