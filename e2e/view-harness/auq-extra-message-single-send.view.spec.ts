import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Regression for ai_todo 446: the AUQ review step's "add a message" extra text
// used to be staged into the held-messages queue AFTER the answer's own send,
// so it sat unsent until the user hit "Send now". Fixed in
// permission-modal/index.ts's onSubmit by staging the extras FIRST, then
// letting the single flushHeldWithDraft() call fold them (via the real
// bundleHeld, cca356d8) alongside the answer's isolated sentinel block into
// ONE outgoing bundle.
//
// Drives the real UI: handleQuestionRequested -> showQuestionCard ->
// renderQuestionUI, real DOM clicks/typing through Next -> Review -> Submit,
// a real HeldMessages instance (stage/flushHeldWithDraft/bundleHeld all
// production code) with only its `send` I/O boundary stubbed to capture the
// outgoing bundle instead of hitting the daemon.

declare global {
  interface Window {
    __sentBundles?: Array<Array<{ type: string; text?: string }>>;
    __held?: { hasItemsForActive(): boolean };
  }
}

test.describe("view-harness / AUQ review-step extra message rides in the SAME send as the answer", () => {
  test("answering a 2-question card + typing an extra message sends exactly once, folded correctly", async ({ page }) => {
    await mountView(page, { invoke: { respond_question: null } });

    await page.evaluate(async () => {
      const qm = await import("/views/sessions/permission-modal/index.ts");
      const sm = await import("/views/sessions/state.ts");
      const { HeldMessages } = await import("/shared/chat/held-messages.ts");

      const sid = "sess-1";
      sm.state.selectedId = sid;
      qm.setSelectedSessionId(sid);

      const pane = document.createElement("div");
      pane.innerHTML = '<div class="session-composer"></div>';
      document.body.appendChild(pane);

      window.__sentBundles = [];
      const held = new HeldMessages();
      held.attach({
        sessionId: sid,
        chipSlot: document.createElement("div"),
        anchor: document.createElement("div"),
        send: (blocks) => { window.__sentBundles!.push(blocks as Array<{ type: string; text?: string }>); },
        interrupt: async () => {},
        getDraftBlocks: () => [],
        isDraftEmpty: () => true,
        isComposing: () => false,
        clearComposer: () => {},
        focusComposer: () => {},
        getIsBusy: () => false,
        onChange: () => {},
      });
      window.__held = held;
      sm.state.heldMessages = held;

      qm.handleQuestionRequested({
        id: "q1",
        session_id: sid,
        questions: [
          { question: "Q1?", header: "Q1", options: [{ label: "A" }, { label: "B" }] },
          { question: "Q2?", header: "Q2", options: [{ label: "X" }, { label: "Y" }] },
        ],
      });
    });

    const card = page.locator(".prompt-card");
    await expect(card).toBeVisible();

    // Q1 (single-select, auto-advances to Q2 since it's not the last question).
    await card.locator('.prompt-opt input[data-label="A"]').click();
    await expect(card.locator(".prompt-panel.is-active .prompt-q__text")).toHaveText("Q2?");

    // Q2 is last: answering it does not auto-advance further; the arrow leads
    // to the summary panel instead.
    await card.locator('.prompt-opt input[data-label="X"]').click();
    await card.locator('.prompt-pager [data-nav="1"]').click();

    // Summary screen: type the extra message, then Submit (the footer's single
    // primary button, which reads Submit only on review).
    await card.locator(".prompt-extra-input").fill("Also check the CI logs while you're at it.");
    await card.locator('[data-act="primary"]').click();

    await expect(card).toHaveCount(0);

    const result = await page.evaluate(async () => {
      // Imported, not re-declared: the sentinel carries an `id` attribute once a
      // card is named, so a local copy of the bare spelling silently stops matching.
      const { AUQ_ANSWER_PREFIX, AUQ_ANSWER_RE } = await import("/shared/chat/chat-event-to-message.ts");
      const bundles = window.__sentBundles!;
      const bundle = bundles[0] ?? [];
      const sentinelBlock = bundle.find((b) => b.type === "text" && b.text?.startsWith(AUQ_ANSWER_PREFIX));
      const extraBlock = bundle.find((b) => b.type === "text" && b.text?.includes("CI logs"));
      return {
        sendCount: bundles.length,
        foldText: sentinelBlock ? sentinelBlock.text!.replace(AUQ_ANSWER_RE, "") : null,
        extraText: extraBlock?.text ?? null,
        stillHeld: window.__held!.hasItemsForActive(),
      };
    });

    // Exactly one send - the extras did not go out as a second, later message.
    expect(result.sendCount).toBe(1);
    // The fold text is ONLY the Q/A pair - no leaked extra prose.
    expect(result.foldText).toContain("Q: Q1?\nA: A");
    expect(result.foldText).toContain("Q: Q2?\nA: X");
    expect(result.foldText).not.toContain("CI logs");
    // The extra still rides in the same bundle, tagged with its own sentinel
    // (9c7f0ce6) so the card folds it rather than spawning a detached bubble.
    expect(result.extraText).toBe("<auq-extra/>Also check the CI logs while you're at it.");
    // Nothing left sitting in the held queue after the single flush.
    expect(result.stillHeld).toBe(false);
  });
});
