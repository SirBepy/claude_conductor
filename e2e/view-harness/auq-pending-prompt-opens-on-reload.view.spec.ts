// asserts: src/views/sessions/active-session.ts, src/views/sessions/permission-modal/resurface.ts
// Reviewed 2026-10-30: active-session.ts gained an empty .next-chip-slot above the composer (quick reply chips) - additive, no change to this spec's contract; the full view suite passed.
import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// Regression (Joe, after an app update): a question the daemon still holds for
// the chat on screen came back as a collapsed "1/1 Skip" band instead of an
// open card. Drives the real sidebar + selectSession against a daemon whose
// list_pending_prompts carries the prompt, the way a reloaded window sees it.

const SESSIONS = [sessionInstance(), sessionInstance({ session_id: "s2", cwd: "C:/Projects/beta", project_id: "p2", name: "Beta chat" })];
const PROMPT_ID = "799df8a4-9d30-4294-bbb1-36b05a4b6949";

const PENDING = [
  {
    id: PROMPT_ID,
    event: "question-requested",
    durable: true,
    payload: {
      id: PROMPT_ID,
      session_id: "s1",
      seq: 3,
      questions: [{ question: "Should Claude build it?", options: [{ label: "Yes" }, { label: "No" }] }],
    },
  },
];

const ANSWERED_IN_TRANSCRIPT = {
  events: [{
    type: "user_message",
    content: [{ type: "text", text: `<auq-answer id="${PROMPT_ID}"/>User answered the question(s):
Q: Should Claude build it?
A: Yes` }],
    timestamp: 0,
    remote_echo: false,
  }],
  oldest_seq: 0,
  newest_seq: 0,
  has_more: false,
};

async function mountSessions(
  page: Page,
  over: { pending?: unknown[]; history?: unknown } = {},
): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: SESSIONS,
      get_active_sessions: SESSIONS,
      list_pending_prompts: over.pending ?? PENDING,
      get_session_drafts: {},
      respond_question: false,
      load_history_page: over.history ?? { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().waitFor();
}

async function skipCalls(page: Page): Promise<Array<{ id?: string; sessionId?: string; skipped?: boolean }>> {
  return page.evaluate(() =>
    ((window as unknown as { __ccInvokeCalls: Array<{ cmd: string; args?: { id?: string; sessionId?: string; skipped?: boolean } }> }).__ccInvokeCalls)
      .filter((c) => c.cmd === "respond_question" && c.args?.skipped === true)
      .map((c) => c.args ?? {}),
  );
}

async function openChat(page: Page, sessionId: string): Promise<void> {
  await page.locator(`#sessions-list li[data-session-id="${sessionId}"]`).click();
  await page.locator("#session-pane .session-composer").waitFor();
}

test.describe("view-harness / a daemon-pending question opens expanded", () => {
  test("opening the chat shows the open card, not the collapsed band", async ({ page }) => {
    await mountSessions(page);
    await openChat(page, "s1");

    await expect(page.locator(".prompt-card")).toHaveCount(1);
    await expect(page.locator(".prompt-collapsed")).toHaveCount(0);
  });

  test("after a page reload the re-opened chat shows the card open, not collapsed", async ({ page }) => {
    await mountSessions(page);
    await openChat(page, "s1");
    await expect(page.locator(".prompt-card")).toHaveCount(1);

    // A hard reload lands on the empty pane (loadLastSelectedSession only
    // serves in-run recovery), so the chat is opened by hand.
    await page.reload();
    await page.locator("#sessions-list li[data-session-id]").first().waitFor();
    await openChat(page, "s1");

    await expect(page.locator(".prompt-card")).toHaveCount(1);
    await expect(page.locator(".prompt-collapsed")).toHaveCount(0);
  });

  test("a minimized card re-expands when its chat is re-selected from the list", async ({ page }) => {
    await mountSessions(page);
    await openChat(page, "s1");
    await page.locator('.prompt-card [data-act="minimize"]').click();
    await expect(page.locator(".prompt-collapsed")).toHaveCount(1);

    await openChat(page, "s1");

    await expect(page.locator(".prompt-card")).toHaveCount(1);
    await expect(page.locator(".prompt-collapsed")).toHaveCount(0);
  });

  test("a reload that finds the prompt already answered in the transcript shows no card and settles it on the daemon", async ({ page }) => {
    await mountSessions(page, { history: ANSWERED_IN_TRANSCRIPT });
    await openChat(page, "s1");

    await expect.poll(() => skipCalls(page)).toHaveLength(1);
    await expect(page.locator(".prompt-card")).toHaveCount(0);
    await expect(page.locator(".prompt-collapsed")).toHaveCount(0);
    expect((await skipCalls(page))[0]).toMatchObject({ id: PROMPT_ID, sessionId: "s1", skipped: true });
  });

  test("a skipped question stays gone when leaving the chat and coming back", async ({ page }) => {
    await mountSessions(page);
    await openChat(page, "s1");
    await page.locator('.prompt-card [data-act="minimize"]').click();
    await page.locator('.prompt-collapsed [data-act="cancel"]').click();
    await expect(page.locator(".prompt-collapsed")).toHaveCount(0);

    await openChat(page, "s2");
    await openChat(page, "s1");

    await expect(page.locator(".prompt-card")).toHaveCount(0);
    await expect(page.locator(".prompt-collapsed")).toHaveCount(0);
  });

  test("a parked question the daemon no longer lists is not re-shown on switch-back", async ({ page }) => {
    await mountSessions(page, { pending: [] });
    await openChat(page, "s1");
    await page.evaluate(async (id) => {
      const qm = await import("/views/sessions/permission-modal/index.ts");
      qm.handleQuestionRequested({ id, session_id: "s1", questions: [{ question: "Ghost?", options: [{ label: "Yes" }] }] });
    }, PROMPT_ID);
    await expect(page.locator(".prompt-card")).toHaveCount(1);

    await openChat(page, "s2");
    await openChat(page, "s1");

    await expect(page.locator(".prompt-card")).toHaveCount(0);
    await expect(page.locator(".prompt-collapsed")).toHaveCount(0);
  });

  test("a minimized card re-expands when its transcript card is clicked and when the prompt is re-announced", async ({ page }) => {
    await mountSessions(page);
    await openChat(page, "s1");
    await page.locator('.prompt-card [data-act="minimize"]').click();
    await expect(page.locator(".prompt-collapsed")).toHaveCount(1);

    await page.evaluate(async () => {
      const qm = await import("/views/sessions/permission-modal/index.ts");
      await qm.reopenPendingPrompt("s1", "toolu_01ULdtGKPTGNUqFwfGG5sfAp");
    });
    await expect(page.locator(".prompt-card")).toHaveCount(1);
    await expect(page.locator(".prompt-collapsed")).toHaveCount(0);

    await page.locator('.prompt-card [data-act="minimize"]').click();
    await expect(page.locator(".prompt-collapsed")).toHaveCount(1);
    await page.evaluate(async (id) => {
      const qm = await import("/views/sessions/permission-modal/index.ts");
      qm.handleQuestionRequested({ id, session_id: "s1", questions: [{ question: "Should Claude build it?", options: [{ label: "Yes" }, { label: "No" }] }] });
    }, PROMPT_ID);
    await expect(page.locator(".prompt-card")).toHaveCount(1);
    await expect(page.locator(".prompt-collapsed")).toHaveCount(0);
  });

  test("switching to another chat while the first is still loading never mounts its question over the second", async ({ page }) => {
    await mountSessions(page);
    // Hold s1's history read open so its mount is genuinely in flight when the
    // user clicks away; s2 reads as usual.
    await page.evaluate(() => {
      const w = window as unknown as {
        __TAURI__: { core: { invoke: (cmd: string, args?: { sessionId?: string }) => Promise<unknown> } };
        __releaseS1?: () => void;
      };
      const orig = w.__TAURI__.core.invoke;
      const gate = new Promise<void>((resolve) => { w.__releaseS1 = resolve; });
      w.__TAURI__.core.invoke = (cmd, args) =>
        cmd === "load_history_page" && args?.sessionId === "s1"
          ? gate.then(() => orig(cmd, args))
          : orig(cmd, args);
    });

    await page.locator('#sessions-list li[data-session-id="s1"]').click();
    await openChat(page, "s2");
    await page.evaluate(() => (window as unknown as { __releaseS1: () => void }).__releaseS1());
    // Let every continuation of s1's abandoned mount run.
    await page.waitForTimeout(800);

    await expect(page.locator(".prompt-card")).toHaveCount(0);
    await expect(page.locator(".prompt-collapsed")).toHaveCount(0);

    // The question is still s1's: it opens there when the user returns.
    await openChat(page, "s1");
    await expect(page.locator(".prompt-card")).toHaveCount(1);
  });

  test("switching away while the daemon's pending-prompt lookup is in flight never mounts the question over the second chat", async ({ page }) => {
    await mountSessions(page);
    await page.evaluate(() => {
      const w = window as unknown as {
        __TAURI__: { core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } };
        __releaseList?: () => void;
      };
      const orig = w.__TAURI__.core.invoke;
      const gate = new Promise<void>((resolve) => { w.__releaseList = resolve; });
      w.__TAURI__.core.invoke = (cmd, args) =>
        cmd === "list_pending_prompts" ? gate.then(() => orig(cmd, args)) : orig(cmd, args);
    });

    await page.locator('#sessions-list li[data-session-id="s1"]').click();
    await page.locator("#session-pane .session-composer").waitFor();
    await page.locator('#sessions-list li[data-session-id="s2"]').click();
    await page.locator("#session-pane .session-composer").waitFor();
    await page.evaluate(() => (window as unknown as { __releaseList: () => void }).__releaseList());
    await page.waitForTimeout(800);

    await expect(page.locator(".prompt-card")).toHaveCount(0);
    await expect(page.locator(".prompt-collapsed")).toHaveCount(0);
  });

  test("a question announced for the first chat mid-load does not follow the user to the second chat", async ({ page }) => {
    await mountSessions(page, { pending: [] });
    await page.evaluate(() => {
      const w = window as unknown as {
        __TAURI__: { core: { invoke: (cmd: string, args?: { sessionId?: string }) => Promise<unknown> } };
        __releaseS1?: () => void;
      };
      const orig = w.__TAURI__.core.invoke;
      const gate = new Promise<void>((resolve) => { w.__releaseS1 = resolve; });
      w.__TAURI__.core.invoke = (cmd, args) =>
        cmd === "load_history_page" && args?.sessionId === "s1"
          ? gate.then(() => orig(cmd, args))
          : orig(cmd, args);
    });

    await page.locator('#sessions-list li[data-session-id="s1"]').click();
    await page.locator("#session-pane .session-composer").waitFor();
    await page.evaluate(async (id) => {
      const qm = await import("/views/sessions/permission-modal/index.ts");
      qm.handleQuestionRequested({ id, session_id: "s1", questions: [{ question: "Mid-load?", options: [{ label: "Yes" }] }] });
    }, PROMPT_ID);
    await openChat(page, "s2");
    await page.evaluate(() => (window as unknown as { __releaseS1: () => void }).__releaseS1());
    await page.waitForTimeout(800);

    await expect(page.locator(".prompt-card")).toHaveCount(0);
    await expect(page.locator(".prompt-collapsed")).toHaveCount(0);
  });
});
