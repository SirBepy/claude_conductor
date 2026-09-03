import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Regression (todo 849): reopenPendingPrompt's no-local-park path used to fetch
// list_pending_prompts twice, once in rehydratePendingPrompts and again in
// newestOpenQuestion, for the same session on the same click.

const DAEMON_PROMPT_ID = "799df8a4-9d30-4294-bbb1-36b05a4b6949";

interface InvokeCall { cmd: string; args?: { id?: string } }

async function listPendingPromptsCalls(page: import("@playwright/test").Page): Promise<InvokeCall[]> {
  return page.evaluate(() =>
    ((window as unknown as { __ccInvokeCalls: InvokeCall[] }).__ccInvokeCalls)
      .filter((c) => c.cmd === "list_pending_prompts")
  );
}

test.describe("view-harness / reopening a transcript card fetches pending prompts once", () => {
  test("an MCP-tool_use_id reopen issues exactly one list_pending_prompts call", async ({ page }) => {
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

      sm.state.sessions = [{ session_id: "sess-A" }] as unknown as typeof sm.state.sessions;
      sm.state.selectedId = "sess-A";
      qm.setSelectedSessionId("sess-A");

      const pane = document.createElement("div");
      pane.innerHTML = '<div class="session-composer"></div>';
      document.body.appendChild(pane);

      // A transcript card only ever knows Claude's tool_use_id, which can
      // never match the daemon's own prompt uuid (todo 833) - this always
      // walks the rehydrate-then-newest-open-question path.
      await qm.reopenPendingPrompt("sess-A", "toolu_01ULdtGKPTGNUqFwfGG5sfAp");
    });

    const calls = await listPendingPromptsCalls(page);
    expect(calls).toHaveLength(1);
  });
});
