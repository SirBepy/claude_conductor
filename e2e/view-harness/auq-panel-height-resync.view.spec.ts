import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Adopted orphan (question-ui-render.ts's panelResizeObs): .prompt-track-viewport
// clips vertically (see its CSS doc comment), so a one-shot height snapshot
// goes stale after a post-render reflow and cuts the last option off. Assert
// the last option's box stays fully inside the clipped viewport.

function options(n: number) {
  return Array.from({ length: n }, (_, i) => ({ label: `Option ${i + 1}` }));
}

test("a post-render reflow re-syncs the track height so the last option stays visible", async ({ page }) => {
  await mountView(page, { invoke: { list_slash_commands: [] } });

  await page.evaluate(async (opts) => {
    const mod = await import("/views/sessions/permission-modal/question-ui.ts");
    mod.renderQuestionUI({
      questions: [{ question: "Pick one?", options: opts }],
      titleIcon: "ph-chat-circle-dots",
      submitLabel: "Submit",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      onSubmit: () => {},
      onCancel: () => {},
    });
  }, options(4));

  const card = page.locator(".prompt-card");
  await expect(card).toBeVisible();

  // Simulate the reflow: grow the last option's own content well after the
  // initial height snapshot was taken (markdown/webfont swap-in stand-in).
  await page.evaluate(() => {
    const label = document.querySelector(".prompt-panel.is-active .prompt-opt:last-child .prompt-opt__label");
    if (label) label.textContent = "A much longer option label that wraps onto several extra lines".repeat(3);
  });

  // ResizeObserver callbacks land on their own frame - poll until the track's
  // inline height catches up with the (now taller) active panel's own height.
  await expect.poll(() =>
    page.evaluate(() => {
      const track = document.querySelector<HTMLElement>(".prompt-track")!;
      const panel = document.querySelector<HTMLElement>(".prompt-panel.is-active")!;
      return Math.abs(parseFloat(track.style.height) - panel.offsetHeight) < 1;
    }),
  ).toBe(true);

  const { optBottom, viewportBottom } = await page.evaluate(() => {
    const viewport = document.querySelector(".prompt-track-viewport")!.getBoundingClientRect();
    const lastOpt = document.querySelector(".prompt-panel.is-active .prompt-opt:last-child")!.getBoundingClientRect();
    return { optBottom: lastOpt.bottom, viewportBottom: viewport.bottom };
  });
  // The clipped viewport's bottom edge must sit at or below the last
  // option's own bottom edge - a stale (small) height leaves the viewport's
  // edge above it, clipping the option's text off mid-line.
  expect(optBottom).toBeLessThanOrEqual(viewportBottom + 1);

  await card.screenshot({
    path: ".for_bepy/screenshots/19592-134315215212210884/auq-panel-height-resync.png",
  });
});
