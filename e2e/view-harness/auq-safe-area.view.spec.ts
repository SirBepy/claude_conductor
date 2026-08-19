import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Regression gate for the Android "Submit unreachable" bug: the host never
// referenced env(safe-area-inset-bottom), so a fixed 24px offset let the
// footer sit under the nav bar. Content alone can't overflow this 852px
// viewport (max-height caps it) - the CDP override reproduces the bug.

const INSET = 100;

async function overrideSafeArea(page: import("@playwright/test").Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", {
    insets: { bottom: INSET, bottomMax: INSET },
  } as never);
}

async function openContentHeavyCard(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(async () => {
    const mod = await import("/views/sessions/permission-modal/question-ui.ts");
    const manyOptions = Array.from({ length: 12 }, (_, i) => ({
      label: `Option number ${i + 1} with a longer label`,
      description: "A fairly long description line to pad this option's rendered height out.",
    }));
    mod.renderQuestionUI({
      questions: [
        { question: "Which approach should we take, given the constraints?", header: "Approach", options: manyOptions },
      ],
      titleIcon: "ph-chat-circle-dots",
      submitLabel: "Submit",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      onSubmit: () => {},
      onCancel: () => {},
    });
  });
}

test("footer stays clear of the safe-area inset on a phone viewport (no host/pane mounted -> --viewport mode)", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await mountView(page);
  await overrideSafeArea(page);
  await openContentHeavyCard(page);

  const footer = page.locator(".prompt-card__footer");
  await expect(footer).toBeVisible();
  const box = (await footer.boundingBox())!;

  // The nav bar covers the bottom INSET px of the 852px viewport - the
  // Submit button must clear that line, not just the raw viewport edge.
  expect(box.y + box.height).toBeLessThanOrEqual(852 - INSET);
});
