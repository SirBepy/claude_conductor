import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Regression for ai_todo 841: respond_question (the settle call) rejecting
// must NOT block answer delivery. permission.rs's respond_question_inner has
// no error path of its own, so a reject here is transport/arg-level only and
// carries no evidence the prompt is unsafe to answer.

declare global {
  interface Window {
    __sendMessageCalls?: number;
  }
}

test.describe("view-harness / AUQ falls through to delivery after a failed settle", () => {
  test("respond_question rejected: send_message still fires", async ({ page }) => {
    await mountView(page, { invoke: { send_message: null } });
    page.on("console", (m) => console.log("[BROWSER]", m.text()));

    await page.evaluate(async () => {
      const qm = await import("/views/sessions/permission-modal/index.ts");
      const sm = await import("/views/sessions/state.ts");

      const sid = "sess-1";
      sm.state.selectedId = sid;
      qm.setSelectedSessionId(sid);
      // No held-messages controller attached: onSubmit takes the direct
      // invoke("send_message") branch, not flushHeldWithDraft.
      sm.state.heldMessages = null;

      window.__sendMessageCalls = 0;
      const w = window as unknown as {
        __TAURI__: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
      };
      const realInvoke = w.__TAURI__.core.invoke;
      w.__TAURI__.core.invoke = (cmd, args) => {
        if (cmd === "respond_question") return Promise.reject(new Error("settle failed"));
        if (cmd === "send_message") {
          window.__sendMessageCalls = (window.__sendMessageCalls ?? 0) + 1;
        }
        return realInvoke(cmd, args);
      };

      qm.handleQuestionRequested({
        id: "q1",
        session_id: sid,
        questions: [{ question: "Q1?", header: "Q1", options: [{ label: "A" }, { label: "B" }] }],
      });
    });

    const card = page.locator(".prompt-card");
    await expect(card).toBeVisible();
    await card.locator('.prompt-opt input[data-label="A"]').click();
    // A one-question card submits in a single step (ai_todo 821); only two or
    // more questions get a review panel.
    await card.locator('[data-act="primary"]').click();

    await expect(card).toHaveCount(0);

    // The failed settle must not surface as a delivery-failure toast - the
    // delivery attempt itself succeeds.
    await expect(page.locator(".toast")).toHaveCount(0);

    const result = await page.evaluate(() => window.__sendMessageCalls);
    expect(result).toBe(1);
  });
});
