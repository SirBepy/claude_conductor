import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// AUQ colored /slash-token highlighting (ai_todo composer-unification): the
// per-question free-text field now gets the same highlight backdrop the main
// composer uses (via the shared composer-core), not just the "/" suggestion
// popup that landed earlier (fc2c0d75). A typed "/skill-name" that resolves
// to a known user-skill should paint a purple cm-slash-user-skill span in the
// backdrop behind the (now transparent-text) textarea.

const SLASH_ENTRIES = [
  { name: "close", args: null, description: "Session retrospective", source: { kind: "user-skill" } },
];

test("typing a known /skill in the AUQ free-text field renders a purple cm-slash span in the highlight backdrop", async ({ page }) => {
  await mountView(page, { invoke: { list_slash_commands: SLASH_ENTRIES } });

  await page.evaluate(async () => {
    const mod = await import("/views/sessions/permission-modal/question-ui.ts");
    mod.renderQuestionUI({
      questions: [{ question: "Which approach?", header: "Approach", options: [{ label: "A" }, { label: "B" }] }],
      titleIcon: "ph-chat-circle-dots",
      submitLabel: "Submit",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      onSubmit: () => {},
      onCancel: () => {},
    });
  });

  const card = page.locator(".prompt-card");
  const input = card.locator(".prompt-q__other-input");
  await input.fill("/close");

  const highlight = card.locator(".prompt-q__other .cc-typing-highlight");
  const span = highlight.locator(".cm-slash-user-skill");
  await expect(span).toHaveCount(1);
  await expect(span).toHaveText("/close");

  // The real textarea's own text must be transparent (backdrop technique) -
  // otherwise the colored span behind it would be invisible/redundant.
  const textColor = await input.evaluate((el) => getComputedStyle(el).color);
  expect(textColor).toBe("rgba(0, 0, 0, 0)");
});
