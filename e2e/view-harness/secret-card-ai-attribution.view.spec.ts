// asserts: src/views/sessions/permission-modal/secret-card.ts
import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";

const SHOT_DIR = ".for_bepy/screenshots/45936-134369823088871704";

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

test("the secret card marks its text as the AI's and carries the fixed warning", async ({ page }) => {
  const card = await mount(page);
  await expect(card.locator(".prompt-card__title")).toContainText("The AI in");
  await expect(card.locator(".prompt-card__title")).toContainText("is asking for a secret");
  await expect(card.locator(".secret-card__quote-k")).toHaveText("The AI's words");
  await expect(card.locator(".secret-card__warning")).toContainText("The app never asks for your passwords.");
  await expect(card.locator(".secret-card__input")).toBeVisible();
  await card.screenshot({ path: `${SHOT_DIR}/secret-card-ai-attribution.png` });
});
