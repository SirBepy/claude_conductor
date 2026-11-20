// asserts: src/views/sessions/sidebar-ring.ts, src/views/sessions/chat-heads.ts, src/views/sessions/chat-heads-model.ts
import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance, capture, fireEvent } from "./harness";

// A parked question card puts its chat in the "needs permission" state. A head draws no status ring
// for it (V2 priority badge): the chat wears one red number, however many questions the card holds
// (Joe, 2026-11-04: a 6-question chat showed a full ring; the ring is gone, the number is the one card).

const q = (n: number) => ({ question: `Question ${n}?`, header: `Q${n}`, options: [{ label: "Yes" }, { label: "No" }] });
const SESSIONS = [
  sessionInstance({ session_id: "s-six", name: "Six questions", pid: 101 }),
  sessionInstance({ session_id: "s-one", name: "One question", pid: 102 }),
];
const prompt = (sessionId: string, count: number) => ({
  id: `prompt-${sessionId}`, session_id: sessionId, seq: 1, questions: Array.from({ length: count }, (_, i) => q(i + 1)),
});

async function mountSessions(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: SESSIONS,
      get_active_sessions: SESSIONS,
      list_pending_prompts: [],
      get_session_drafts: {},
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().waitFor();
  await fireEvent(page, "question-requested", [prompt("s-six", 6), prompt("s-one", 1)]);
  await expect.poll(() => page.locator("#sessions-list .row-entering").count()).toBe(0);
}

const badge = (page: Page, id: string) => page.locator(`#sessions-list li[data-session-id="${id}"] .chat-head-tag .ht-n`);

test.describe("view-harness / chat head parked question card", () => {
  test("a six-question card is one red number and no ring", async ({ page }) => {
    await mountSessions(page);
    await expect(badge(page, "s-six")).toHaveText("1");
    await expect(badge(page, "s-six")).toHaveClass(/is-red/);
    await expect(page.locator("#sessions-list .avatar-ring")).toHaveCount(0);
    await capture(page.locator("#sessions-list"), "chat-heads-parked-question-badge");
  });

  test("a single question is one red number too", async ({ page }) => {
    await mountSessions(page);
    await expect(badge(page, "s-one")).toHaveText("1");
    await expect(badge(page, "s-one")).toHaveClass(/is-red/);
  });
});
