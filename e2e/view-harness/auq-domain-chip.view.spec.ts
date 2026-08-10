import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Todo 565: the domain chip used to live only inside the Context row splitAsk()
// produces, so a terse one-sentence question rendered no chip at all. It now
// falls back into the ask band. Badges ride the option rows either way.

const TERSE = {
  question: "Which approach?",
  header: "Approach",
  domain: "arch",
  options: [
    { label: "Rewrite", description: "start clean", badges: ["recommended", "long_term"] },
    { label: "Patch", description: "smallest diff", badges: ["short_term"] },
  ],
};

const WITH_CONTEXT = {
  ...TERSE,
  question: "The relay drops frames under load. Which approach?",
};

async function mount(page, question) {
  await mountView(page, { invoke: { list_slash_commands: [] } });
  await page.evaluate(async (q) => {
    const mod = await import("/views/sessions/permission-modal/question-ui.ts");
    mod.renderQuestionUI({
      questions: [q],
      titleIcon: "ph-chat-circle-dots",
      titleText: "Claude is asking",
      submitLabel: "Submit",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      onSubmit: () => {},
      onCancel: () => {},
    });
  }, question);
  return page.locator(".prompt-card");
}

test("a terse question shows the domain chip in the ask band", async ({ page }) => {
  const card = await mount(page, TERSE);

  await expect(card.locator(".prompt-zone--ctx")).toHaveCount(0);
  const chip = card.locator(".prompt-zone--ask .prompt-domain");
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveText(/arch/i);

  // Visible, not merely in the DOM: real size, and inside the ask band's bounds.
  const chipBox = await chip.boundingBox();
  const askBox = await card.locator(".prompt-zone--ask").boundingBox();
  expect(chipBox!.width).toBeGreaterThan(30);
  expect(chipBox!.height).toBeGreaterThan(12);
  expect(chipBox!.x).toBeGreaterThan(askBox!.x);
  expect(chipBox!.x + chipBox!.width).toBeLessThanOrEqual(askBox!.x + askBox!.width + 1);

  await card.screenshot({
    path: ".for_bepy/screenshots/36652-639219531179461135/auq-domain-chip-terse.png",
  });
});

test("option badges render with their labels", async ({ page }) => {
  const card = await mount(page, TERSE);

  const badges = card.locator(".prompt-opt .prompt-badge");
  await expect(badges).toHaveCount(3);
  await expect(badges.nth(0)).toBeVisible();
  await expect(card.locator(".prompt-badge--rec")).toHaveCount(1);
});

test("a question WITH context keeps the chip on the context row, never both", async ({ page }) => {
  const card = await mount(page, WITH_CONTEXT);

  await expect(card.locator(".prompt-ctx__head .prompt-domain")).toHaveCount(1);
  await expect(card.locator(".prompt-zone--ask .prompt-domain")).toHaveCount(0);

  await card.screenshot({
    path: ".for_bepy/screenshots/36652-639219531179461135/auq-domain-chip-context.png",
  });
});
