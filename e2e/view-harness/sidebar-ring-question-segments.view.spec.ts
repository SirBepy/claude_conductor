// Reviewed 2026-11-12 (honest sub states): subs gained queued/paused/usage-limit/stopped kinds with a dim ring and glyph, an avatar hover card, the Plan foot's sub counts and a glowing main-chat ring; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-10 (dash lane 3): the Subchats card, Pin to sidemenu (replacing Move to sidebar in the chat menu) and the effort battery colours change nothing this spec asserts; it passes.
// Reviewed 2026-11-05: a main chat waiting for its subs to close stays in Main chats with an hourglass, the sub list orders Finished by finish time, a sub header wears its list initials and the all-finished card names unmerged subs; this spec asserts none of those and it passes.
// asserts: src/views/sessions/sidebar-ring.ts, src/views/sessions/sidebar-rows.ts
import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance, capture, fireEvent } from "./harness";

// A parked question card puts its chat in the "needs permission" state, so the
// ring must still draw one segment per question: a whole pulsing ring means
// exactly one question (Joe, 2026-11-04: a 6-question chat showed a full ring).

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
  await expect.poll(() => page.locator(".sessions-list .row-entering").count()).toBe(0);
}

const ring = (page: Page, id: string) => page.locator(`#sessions-list li[data-session-id="${id}"] .avatar-ring circle`);

test.describe("view-harness / sidebar ring question segments", () => {
  test("a six-question card draws six segments with only the first pulsing", async ({ page }) => {
    await mountSessions(page);
    await expect(ring(page, "s-six")).toHaveCount(6);
    await expect(ring(page, "s-six").first()).toHaveClass(/is-pulse/);
    await expect(page.locator('#sessions-list li[data-session-id="s-six"] .avatar-ring .is-pulse')).toHaveCount(1);
    await capture(page.locator("#sessions-list"), "sidebar-ring-question-segments");
  });

  test("a single question is one whole pulsing ring", async ({ page }) => {
    await mountSessions(page);
    await expect(ring(page, "s-one")).toHaveCount(1);
    await expect(ring(page, "s-one")).toHaveClass(/is-pulse/);
  });

  test("a rebuilt ring resumes mid-cycle instead of restarting its pulse", async ({ page }) => {
    await mountSessions(page);
    await page.waitForTimeout(700);
    const delay = await ring(page, "s-one").evaluate((el) => getComputedStyle(el).animationDelay);
    expect(parseFloat(delay)).toBeLessThan(0);
  });
});
