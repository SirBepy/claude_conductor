import { test, expect } from "@playwright/test";
import { mountView, invokeCalls } from "./harness";

// c306a4b4: permission-card.ts's fallback card passes supportsExtras: true, so
// the free-text "add a message" box is reachable, folded into respond_permission
// on submit. ai_todo 821: a single question inlines that box, no review panel.

const QUESTION_INPUT = {
  questions: [{ question: "Proceed with deploy?", options: [{ label: "Yes" }, { label: "No" }] }],
};

test("fallback card with one question inlines the append box and submits in one step", async ({ page }) => {
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

  const extraInput = card.locator(".prompt-extra-input");
  await expect(extraInput).toBeVisible();
  await extraInput.fill("please also check staging");
  await expect(extraInput).toHaveValue("please also check staging");

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
