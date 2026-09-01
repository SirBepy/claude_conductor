import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Regression for ai_todo 820: a failed follow-up send_message went unsurfaced
// (respond_question already accepted the card) and clearQuestionDraft ran
// unconditionally, destroying the typed answer. Fixed: send wrapped in
// try/catch, a toast on failure, draft cleared only once delivery succeeds.

// No state.heldMessages attached, so onSubmit takes the direct
// invoke("send_message") branch (flushHeldWithDraft already has its own
// recovery via sendWithFailureRecovery, ai_todo 800) - drives submit via
// button clicks, not Enter (todo 836 is unrelated and separate).

declare global {
  interface Window {
    __sendMessageCalls?: number;
  }
}

test.describe("view-harness / AUQ answer delivery failure surfaces and stays recoverable", () => {
  test("send_message rejected: a toast appears, the draft survives, no silent success", async ({ page }) => {
    await mountView(page, { invoke: { respond_question: null } });
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
        if (cmd === "send_message") {
          window.__sendMessageCalls = (window.__sendMessageCalls ?? 0) + 1;
          return Promise.reject(new Error("network blip"));
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

    // The card tears down on submit regardless of outcome (question-ui.ts) -
    // the failure signal and draft survival are what's under test, not this.
    await expect(card).toHaveCount(0);

    // The failure signal: a toast, not a silent drop.
    await expect(page.locator(".toast")).toBeVisible();
    await expect(page.locator(".toast")).toContainText("Answer delivery failed");

    const result = await page.evaluate(() => ({
      sendMessageCalls: window.__sendMessageCalls,
      draftSurvived: localStorage.getItem("auq-draft:v1:q1") !== null,
    }));
    expect(result.sendMessageCalls).toBe(1);
    // Recoverable: the failed send must NOT have wiped the typed answer.
    expect(result.draftSurvived).toBe(true);
  });
});
