import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Regression: `respond_question` reports `delivered` - whether a live blocking
// waiter (the MCP `ask_user_question` tool, our only live AUQ path since the
// built-in tool is disabled) was resolved, meaning the answer already reached
// the model in-band as the tool's own result. `showQuestionCard`'s onSubmit
// used to send the answer as a SECOND, redundant chat message regardless,
// racing the in-flight tool_result and occasionally causing Claude to
// re-invoke ask_user_question - the same question card twice, for an answer
// it already had. Fixed by gating the sentinel answer block on `!delivered`;
// extras (an optional typed message / pasted attachments) still must go
// either way, since the tool_result only ever carries the structured answers.

declare global {
  interface Window {
    __sentBundles?: Array<Array<{ type: string; text?: string }>>;
  }
}

test.describe("view-harness / delivered answer sends no duplicate message", () => {
  test("delivered=true and no extras: answering sends nothing at all", async ({ page }) => {
    await mountView(page, { invoke: { respond_question: true } });

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
        getIsBusy: () => false,
        onChange: () => {},
      });
      sm.state.heldMessages = held;

      qm.handleQuestionRequested({
        id: "q1",
        session_id: sid,
        questions: [{ question: "Q1?", header: "Q1", options: [{ label: "A" }, { label: "B" }] }],
      });
    });

    const card = page.locator(".prompt-card");
    await expect(card).toBeVisible();
    await card.locator('.prompt-opt input[data-label="A"]').click();
    // showQuestionCard hardcodes supportsExtras:true, so even a single
    // question gets a review step - Next, then Submit from there.
    await card.locator('[data-act="primary"]').click();
    await card.locator('[data-act="primary"]').click();

    await expect(card).toHaveCount(0);
    const sendCount = await page.evaluate(() => window.__sentBundles!.length);
    expect(sendCount).toBe(0);
  });

  test("delivered=true with an extra message: only the extra travels, no AUQ_ANSWER_SENTINEL block", async ({ page }) => {
    await mountView(page, { invoke: { respond_question: true } });

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
        getIsBusy: () => false,
        onChange: () => {},
      });
      sm.state.heldMessages = held;

      // 2 questions so a review step (with the extra-message field) exists -
      // showQuestionCard hardcodes supportsExtras:true regardless of payload.
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
    await card.locator('.prompt-opt input[data-label="A"]').click();
    await expect(card.locator(".prompt-panel.is-active .prompt-q__text")).toHaveText("Q2?");
    await card.locator('.prompt-opt input[data-label="X"]').click();
    await card.locator('.prompt-pager [data-nav="1"]').click();

    await card.locator(".prompt-extra-input").fill("Also check the CI logs while you're at it.");
    await card.locator('[data-act="primary"]').click();

    await expect(card).toHaveCount(0);
    const result = await page.evaluate(() => {
      const bundles = window.__sentBundles!;
      const bundle = bundles[0] ?? [];
      return {
        sendCount: bundles.length,
        blockCount: bundle.length,
        hasSentinel: bundle.some((b) => b.type === "text" && b.text?.startsWith("<auq-answer/>")),
        extraText: bundle.find((b) => b.type === "text")?.text ?? null,
      };
    });
    expect(result.sendCount).toBe(1);
    expect(result.blockCount).toBe(1);
    expect(result.hasSentinel).toBe(false);
    expect(result.extraText).toBe("Also check the CI logs while you're at it.");
  });
});
