import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Regression (todo 833): a transcript card click answered the card's own
// tool_use_id, which settles no daemon record, so the real prompt stayed in
// pending_prompts and re-surfaced forever. Asserts on the id that reaches
// respond_question, the byte that actually settles the prompt.

const DAEMON_PROMPT_ID = "799df8a4-9d30-4294-bbb1-36b05a4b6949";
const TRANSCRIPT_CARD_ID = "toolu_01ULdtGKPTGNUqFwfGG5sfAp";

declare global {
  interface Window {
    __questionModule?: typeof import("/views/sessions/permission-modal/index.ts");
    __stateModule?: typeof import("/views/sessions/state.ts");
    __reopened?: boolean;
  }
}

interface InvokeCall { cmd: string; args?: { id?: string; skipped?: boolean } }

async function respondQuestionCalls(page: import("@playwright/test").Page): Promise<InvokeCall[]> {
  return page.evaluate(() =>
    ((window as unknown as { __ccInvokeCalls: InvokeCall[] }).__ccInvokeCalls)
      .filter((c) => c.cmd === "respond_question")
  );
}

test.describe("view-harness / reopening a transcript question card settles the DAEMON's prompt id", () => {
  test("Skip on a reopened card answers the daemon uuid, not the transcript tool_use_id", async ({ page }) => {
    await mountView(page, {
      invoke: {
        list_pending_prompts: [
          {
            id: DAEMON_PROMPT_ID,
            event: "question-requested",
            durable: true,
            payload: {
              id: DAEMON_PROMPT_ID,
              session_id: "sess-A",
              seq: 7,
              questions: [{ question: "How should I handle the red gate?", options: [{ label: "Skip it" }, { label: "Fix it" }] }],
            },
          },
        ],
        get_session_drafts: {},
        respond_question: false,
      },
    });

    await page.evaluate(async () => {
      const qm = await import("/views/sessions/permission-modal/index.ts");
      const sm = await import("/views/sessions/state.ts");
      window.__questionModule = qm;
      window.__stateModule = sm;

      sm.state.sessions = [{ session_id: "sess-A" }] as unknown as typeof sm.state.sessions;
      sm.state.selectedId = "sess-A";
      qm.setSelectedSessionId("sess-A");

      const pane = document.createElement("div");
      pane.innerHTML = '<div class="session-composer"></div>';
      document.body.appendChild(pane);

      // What sessions.ts's pane click handler does for a `.tool-qa-a--pending`
      // card: it only ever knows the transcript's id.
      window.__reopened = await qm.reopenPendingPrompt("sess-A", "toolu_01ULdtGKPTGNUqFwfGG5sfAp");
    });

    expect(await page.evaluate(() => window.__reopened)).toBe(true);
    const card = page.locator(".prompt-card");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("How should I handle the red gate?");

    await card.locator('[data-act="cancel"]').click();

    const calls = await respondQuestionCalls(page);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args?.skipped).toBe(true);
    // The whole bug in one assertion: this used to be TRANSCRIPT_CARD_ID.
    expect(calls[0]!.args?.id).toBe(DAEMON_PROMPT_ID);
    expect(calls[0]!.args?.id).not.toBe(TRANSCRIPT_CARD_ID);
  });

  test("with no open daemon prompt, the transcript rebuild still answers the card", async ({ page }) => {
    await mountView(page, {
      invoke: { list_pending_prompts: [], get_session_drafts: {}, respond_question: false },
    });

    await page.evaluate(async () => {
      const qm = await import("/views/sessions/permission-modal/index.ts");
      const sm = await import("/views/sessions/state.ts");
      sm.state.sessions = [{ session_id: "sess-A" }] as unknown as typeof sm.state.sessions;
      sm.state.selectedId = "sess-A";
      qm.setSelectedSessionId("sess-A");
      // The daemon's prompt store is memory-only, so a restart leaves the
      // transcript as the only source - that fallback must survive this fix.
      sm.state.renderer = {
        getOpenQuestion: () => ({
          input: { questions: [{ question: "Survived the daemon restart?", options: [{ label: "Yes" }] }] },
        }),
      } as unknown as typeof sm.state.renderer;

      const pane = document.createElement("div");
      pane.innerHTML = '<div class="session-composer"></div>';
      document.body.appendChild(pane);

      window.__reopened = await qm.reopenPendingPrompt("sess-A", "toolu_01ULdtGKPTGNUqFwfGG5sfAp");
    });

    expect(await page.evaluate(() => window.__reopened)).toBe(true);
    await expect(page.locator(".prompt-card")).toContainText("Survived the daemon restart?");

    await page.locator('.prompt-card [data-act="cancel"]').click();
    const calls = await respondQuestionCalls(page);
    expect(calls[0]!.args?.id).toBe(TRANSCRIPT_CARD_ID);
  });
});
