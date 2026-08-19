import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";

// c306a4b4: permission-card.ts's fallback question card now gates
// rightChipHtml on isAskQuestionTool(payload.tool_name) - hidden for our own
// MCP ask tool (pre-trusted, so it never reaches this fallback for real), kept
// for every other tool as a "this went down the fallback path" tell.

const QUESTION_INPUT = {
  questions: [{ question: "Pick a color?", options: [{ label: "Red" }, { label: "Blue" }] }],
};

async function mountFallbackCard(page: Page, toolName: string) {
  await mountView(page, { invoke: { list_slash_commands: [] } });
  await page.evaluate(async ({ toolName, input }) => {
    const mod = await import("/views/sessions/permission-modal/permission-card.ts");
    mod.showPermissionCard({ id: "perm-1", tool_name: toolName, session_id: undefined, input });
  }, { toolName, input: QUESTION_INPUT });
  return page.locator(".prompt-card");
}

test.describe("fallback question card - tool chip gating", () => {
  test("our own MCP ask tool shows no tool chip", async ({ page }) => {
    const card = await mountFallbackCard(page, "mcp__cc_conductor__ask_user_question");
    await expect(card).toHaveCount(1);
    await expect(card.locator(".prompt-card__tool")).toHaveCount(0);

    await card.screenshot({
      path: ".for_bepy/screenshots/_specs/auq-fallback-chip-own-tool.png",
    });
  });

  test("a different tool still shows the tool chip", async ({ page }) => {
    const card = await mountFallbackCard(page, "Bash");
    await expect(card).toHaveCount(1);
    const chip = card.locator(".prompt-card__tool");
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveText("Bash");

    await card.screenshot({
      path: ".for_bepy/screenshots/_specs/auq-fallback-chip-other-tool.png",
    });
  });
});
