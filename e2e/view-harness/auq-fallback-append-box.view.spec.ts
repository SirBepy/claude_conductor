import { test, expect } from "@playwright/test";
import { mountView, invokeCalls } from "./harness";

// c306a4b4: permission-card.ts's fallback card passes supportsExtras: true, so
// free-text riding along with the pick reaches respond_permission's message.
// ai_todo 850: one question means one box - the question's own answer field.

const QUESTION_INPUT = {
  questions: [{ question: "Proceed with deploy?", options: [{ label: "Yes" }, { label: "No" }] }],
};

test("fallback card with one question shows one box and submits in one step", async ({ page }) => {
  await mountView(page, { invoke: { list_slash_commands: [], respond_permission: null } });
  await page.evaluate(async (input) => {
    const mod = await import("/views/sessions/permission-modal/permission-card.ts");
    mod.showPermissionCard({ id: "perm-append-1", tool_name: "Bash", session_id: undefined, input });
  }, QUESTION_INPUT);

  const card = page.locator(".prompt-card");
  await expect(card).toHaveCount(1);
  await expect(card.locator(".prompt-panel")).toHaveCount(1);
  await expect(card.locator(".prompt-pager [data-nav]")).toHaveCount(0);

  await card.locator('.prompt-panel[data-panel="0"] input[data-label="Yes"]').click();

  await expect(card.locator(".prompt-extra-input")).toHaveCount(0);
  const ownInput = card.locator(".prompt-q__other-input");
  await expect(ownInput).toBeVisible();
  await ownInput.fill("please also check staging");
  await expect(ownInput).toHaveValue("please also check staging");

  await card.screenshot({
    path: ".for_bepy/screenshots/_specs/auq-fallback-append-box.png",
  });

  // One click submits - no review step to page through first.
  await card.locator('[data-act="primary"]').click();
  await expect(card).toHaveCount(0);

  const calls = await invokeCalls(page);
  const respond = calls.find((c) => c.cmd === "respond_permission");
  expect(respond).toBeTruthy();
  const args = respond!.args as { message: string };
  expect(args.message).toContain("please also check staging");
});
