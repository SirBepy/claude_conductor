// Reviewed 2026-10-29: question cards now re-expand from their collapsed bar on re-open/re-announce, a parked question is shown only while the daemon still lists it, and an already-answered one is dropped (answered-gate.ts) - this spec's contract is unchanged and it passes.
// asserts: src/views/sessions/permission-modal-track.css, src/views/sessions/permission-modal-shell.css
// Reviewed 2026-10-28: the phone review Submit's 48px min-height now wins over the footer's 32px button rule - no change to this spec's divider contract.
// Reviewed 2026-10-28: the phone page's ask band now runs edge to edge (track viewport widened over the body padding, panels re-inset) - phone-media only, no change to this spec's contract.
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { mountView } from "./harness";
import { shotDir } from "./shot-dir";

// Shared, gitignored, per-chat folder for the verification shot.
const SHOT = path.join(shotDir(), "question-card-step2.png");

const QUESTIONS = [
  { question: "First?", options: [{ label: "A" }, { label: "B" }] },
  { question: "Second?", options: [{ label: "C" }, { label: "D" }] },
  { question: "Third?", options: [{ label: "E" }, { label: "F" }] },
];

// The track slides panels sideways, so a divider drawn between neighbouring
// panels lands at the card edge once a later question is active; the rule
// must stay off every panel, not just the first.
async function panelLeftBorders(page: Page): Promise<string[]> {
  return page.locator(".prompt-panel").evaluateAll(
    (els) => els.map((el) => getComputedStyle(el).borderLeftWidth),
  );
}

test.describe("view-harness / question card panels carry no divider (desktop)", () => {
  test("no panel has a left border on any step, including the later questions", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mountView(page);
    await page.evaluate(async (q) => {
      const mod = await import("/views/sessions/permission-modal/question-ui.ts");
      mod.renderQuestionUI({
        questions: q as never,
        titleIcon: "ph-chat-circle-dots",
        submitLabel: "Submit",
        submitIcon: "ph-paper-plane-right",
        cancelLabel: "Skip",
        onSubmit: () => {},
        onCancel: () => {},
      });
    }, QUESTIONS);

    const card = page.locator(".prompt-card");
    await expect(card).toBeVisible();
    expect((await page.locator(".prompt-panel").count())).toBeGreaterThanOrEqual(2);
    expect((await panelLeftBorders(page)).every((w) => w === "0px")).toBe(true);

    // A single-select pick advances to the next panel on its own.
    await page.locator('.prompt-panel.is-active .prompt-opt', { hasText: "A" }).click();
    await expect(page.locator(".prompt-panel.is-active")).toHaveAttribute("data-panel", "1");
    await page.waitForTimeout(500); // let the track's slide settle before the shot
    expect(await panelLeftBorders(page)).toEqual(
      Array.from({ length: await page.locator(".prompt-panel").count() }, () => "0px"),
    );
    await card.screenshot({ path: SHOT });

    await page.locator('.prompt-panel.is-active .prompt-opt', { hasText: "C" }).click();
    await expect(page.locator(".prompt-panel.is-active")).toHaveAttribute("data-panel", "2");
    expect((await panelLeftBorders(page)).every((w) => w === "0px")).toBe(true);
  });
});
