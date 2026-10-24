// Reviewed 2026-10-25 (project dashboard moved into new-chat drafts and a page opened from the chat header's project name; the Projects tab, Projects page and project page are gone): this spec drives none of those surfaces and passed after the change, so its contract is unaffected.
// Reviewed 2026-10-20: index.ts gained a `hydrateWrapUpOnDone()` call at install time and re-exports isWrapUpOnDone/setWrapUpOnDone - additive, no change to this spec's AUQ contract.
import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Regression (Joe: clicking a transcript question card's inline preview while
// its own live card is already open flickered the card shut then open again).
// reopenPendingPrompt is what sessions.ts's pane click handler calls for a
// still-`.tool-qa-a--pending` transcript card - once it resolves to the exact
// prompt already live on screen, it must leave that card alone instead of
// dismissing and remounting it.

const DAEMON_PROMPT_ID = "799df8a4-9d30-4294-bbb1-36b05a4b6949";

test.describe("view-harness / reopening the already-active question card is a no-op", () => {
  test("clicking a transcript card for the card already on screen does not remount it", async ({ page }) => {
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

      // First click: nothing parked yet, so this genuinely fetches and opens
      // the live card. reopenPendingPrompt fires showQuestionCard off
      // fire-and-forget (`void`), so its own promise resolving does not mean
      // the card has rendered yet.
      await qm.reopenPendingPrompt("sess-A", "toolu_01ULdtGKPTGNUqFwfGG5sfAp");
    });

    const card = page.locator(".prompt-card");
    await expect(card).toHaveCount(1);
    await page.evaluate(() => {
      (window as unknown as { __cardRef?: Element }).__cardRef = document.querySelector(".prompt-card") ?? undefined;
    });

    // Second click on the SAME transcript card id, while that card is still
    // the one live on screen: must be a no-op, not a dismiss+reopen. The
    // click's own `cardId` is the transcript's tool_use_id, which never
    // equals the daemon's prompt uuid - this always resolves via the
    // "newest open question for the session" fallback, landing back on
    // DAEMON_PROMPT_ID, the same id the live card already carries.
    const result = await page.evaluate(async () => {
      const qm = await import("/views/sessions/permission-modal/index.ts");
      const reopened = await qm.reopenPendingPrompt("sess-A", "toolu_01ULdtGKPTGNUqFwfGG5sfAp");
      const w = window as unknown as { __cardRef?: Element };
      const sameNode = document.querySelector(".prompt-card") === w.__cardRef;
      return { reopened, sameNode };
    });

    expect(result.reopened).toBe(true);
    // Same DOM node still up: never torn down and recreated (the flicker).
    expect(result.sameNode).toBe(true);
    await expect(card).toHaveCount(1);
  });
});
