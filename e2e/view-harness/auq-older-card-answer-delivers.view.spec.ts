import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Regression for todo 860: gating.ts tracked one "latest" prompt id per
// SESSION, so an in-flight settle for an older card found the pointer already
// moved to a newer sibling and dropped the answer before send_message ever
// saw it. Fixed: staleness is now tracked per prompt id, not per session.

declare global {
  interface Window {
    __sendMessageCalls?: Array<{ sessionId?: string; blocks?: Array<{ type: string; text?: string }> }>;
    __resolveOldSettle?: () => void;
  }
}

test.describe("view-harness / answering a still-pending OLDER card still delivers", () => {
  test("a newer sibling arriving mid-settle does not drop the older card's answer", async ({ page }) => {
    await mountView(page, { invoke: {} });
    page.on("console", (m) => console.log("[BROWSER]", m.text()));

    await page.evaluate(async () => {
      const qm = await import("/views/sessions/permission-modal/index.ts");
      const sm = await import("/views/sessions/state.ts");

      const sid = "sess-1";
      sm.state.selectedId = sid;
      qm.setSelectedSessionId(sid);
      // No held-messages controller: onSubmit takes the direct
      // invoke("send_message") branch, easiest to assert on here.
      sm.state.heldMessages = null;

      const pane = document.createElement("div");
      pane.innerHTML = '<div class="session-composer"></div>';
      document.body.appendChild(pane);

      window.__sendMessageCalls = [];
      const w = window as unknown as {
        __TAURI__: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
      };
      const realInvoke = w.__TAURI__.core.invoke;
      // The older card's own respond_question settle is held open, so its
      // onSubmit is still awaiting when the newer sibling's event fires below
      // - the exact race that used to move the session's "latest" pointer out
      // from under it.
      w.__TAURI__.core.invoke = (cmd, args) => {
        if (cmd === "respond_question" && args?.id === "q-old") {
          // false: not a live blocking waiter, so onSubmit still needs to
          // build+send the sentinel-tagged answer block itself below.
          return new Promise((resolve) => { window.__resolveOldSettle = () => resolve(false); });
        }
        if (cmd === "send_message") {
          window.__sendMessageCalls!.push(args as { sessionId?: string; blocks?: Array<{ type: string; text?: string }> });
          return Promise.resolve(null);
        }
        return realInvoke(cmd, args);
      };

      qm.handleQuestionRequested({
        id: "q-old",
        session_id: sid,
        questions: [{ question: "Which monitor?", header: "Monitor", options: [{ label: "Primary" }, { label: "Secondary" }] }],
      });
    });

    const card = page.locator(".prompt-card");
    await expect(card).toBeVisible();
    await card.locator('.prompt-opt input[data-label="Primary"]').click();
    // Card tears down synchronously on submit; onSubmit keeps running async.
    await card.locator('[data-act="primary"]').click();
    await expect(card).toHaveCount(0);

    // The newer, independently-pending sibling arrives while the older
    // card's settle is still in flight.
    await page.evaluate(async () => {
      const qm = await import("/views/sessions/permission-modal/index.ts");
      qm.handleQuestionRequested({
        id: "q-new",
        session_id: "sess-1",
        questions: [{ question: "End with a release?", header: "Release", options: [{ label: "Yes" }, { label: "No" }] }],
      });
    });
    await expect(card).toBeVisible();
    await expect(card).toContainText("End with a release?");

    // Let the older card's settle resolve now that the sibling has landed.
    await page.evaluate(() => window.__resolveOldSettle!());

    await expect.poll(() => page.evaluate(() => window.__sendMessageCalls!.length)).toBe(1);
    const sent = await page.evaluate(() => window.__sendMessageCalls![0]);
    const text = sent?.blocks?.[0]?.text ?? "";
    // (b) delivery is keyed to the OLDER card's own id, not the sibling's.
    expect(text).toContain('id="q-old"');
    expect(text).not.toContain('id="q-new"');
    expect(text).toContain("Primary");

    // The newer card is unaffected by the older one's settle.
    await expect(card).toBeVisible();
    await expect(card).toContainText("End with a release?");
  });
});
