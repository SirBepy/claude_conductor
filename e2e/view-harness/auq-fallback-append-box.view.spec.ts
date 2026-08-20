import { test, expect } from "@playwright/test";
import { mountView, invokeCalls, openAnswerBar } from "./harness";

// c306a4b4: permission-card.ts's fallback card now passes supportsExtras:
// true, so its review step shows the free-text "add a message" box
// (extraMessageZoneHtml, gated at question-ui-render.ts:129) and folds it
// into the respond_permission message on submit.

const QUESTION_INPUT = {
  questions: [{ question: "Proceed with deploy?", options: [{ label: "Yes" }, { label: "No" }] }],
};

test("fallback card review step shows and submits the append box", async ({ page }) => {
  await mountView(page, { invoke: { list_slash_commands: [], respond_permission: null } });
  await page.evaluate(async (input) => {
    const mod = await import("/views/sessions/permission-modal/permission-card.ts");
    mod.showPermissionCard({ id: "perm-append-1", tool_name: "Bash", session_id: undefined, input });
  }, QUESTION_INPUT);

  const card = page.locator(".prompt-card");
  await expect(card).toHaveCount(1);

  // Answer the lone question, then advance to the review panel.
  await card.locator('.prompt-panel[data-panel="0"] input[data-label="Yes"]').click();
  await card.locator('[data-act="primary"]').click();

  await openAnswerBar(card);
  const extraInput = card.locator(".prompt-extra-input");
  await expect(extraInput).toBeVisible();
  await extraInput.fill("please also check staging");
  await expect(extraInput).toHaveValue("please also check staging");

  await card.screenshot({
    path: ".for_bepy/screenshots/_specs/auq-fallback-append-box.png",
  });

  // Submit - the primary button is now "Answer" (submit mode on review).
  await card.locator('[data-act="primary"]').click();
  await expect(card).toHaveCount(0);

  const calls = await invokeCalls(page);
  const respond = calls.find((c) => c.cmd === "respond_permission");
  expect(respond).toBeTruthy();
  const args = respond!.args as { message: string };
  expect(args.message).toContain("please also check staging");
});
