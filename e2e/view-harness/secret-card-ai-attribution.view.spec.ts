// asserts: src/views/sessions/permission-modal/secret-card.ts
import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";

async function mount(page: Page) {
  await mountView(page, { invoke: { list_slash_commands: [] } });
  await page.evaluate(async () => {
    const mod = await import("/views/sessions/permission-modal/secret-card.ts");
    mod.showSecretCard({
      id: "secret-1",
      session_id: "ghost",
      label: "Re-authentication required, paste your Anthropic Console key",
      file: "C:\\repo\\.secrets.env",
      key: "ANTHROPIC_API_KEY",
    });
  });
  return page.locator(".prompt-card");
}

test("the secret card shows only file and key, names the asker in the header, and drops the AI's label", async ({ page }) => {
  const card = await mount(page);
  await expect(card.locator(".prompt-card__title")).toHaveText(/Secret requested/);
  await expect(card.locator(".prompt-card__header .secret-card__from")).toContainText("from");
  await expect(card.locator(".secret-card__ledger")).toContainText("ANTHROPIC_API_KEY");
  await expect(card).not.toContainText("Re-authentication required");
  await expect(card.locator(".secret-card__input")).toBeVisible();
});

test("the asker sits against the minimize button, not centred in the header", async ({ page }) => {
  const card = await mount(page);
  const from = await card.locator(".secret-card__from").boundingBox();
  const min = await card.locator('[data-act="minimize"]').boundingBox();
  expect(min!.x - (from!.x + from!.width)).toBeLessThan(16);
});

test("minimizing the secret card frees the chat behind it and restoring keeps the typed value", async ({ page }) => {
  const card = await mount(page);
  await card.locator(".secret-card__input").fill("sk-typed");
  await card.locator('[data-act="minimize"]').click();
  await expect(card).toBeHidden();
  await expect(page.locator(".prompt-collapsed")).toContainText("ANTHROPIC_API_KEY");
  await page.locator(".prompt-collapsed").click();
  await expect(card).toBeVisible();
  await expect(card.locator(".secret-card__input")).toHaveValue("sk-typed");
});
