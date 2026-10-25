import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";
import type { Question } from "../../src/views/sessions/permission-modal/types";

// asserts: src/views/sessions/permission-modal/preview-fullscreen.ts, src/views/sessions/permission-modal-preview-fullscreen.css
// Fullscreen option previews: tapping a tile or stage picture opens it at the
// full screen size (zoomable), options page left/right along the bottom,
// Select picks and moves to the next question - fullscreen again when that one
// has previews, the normal card when not. Back = previous question, X = card.

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 393, height: 852 };

const frag = (label: string) =>
  `<div class="probe" style="padding:10px;background:var(--color-surface);color:var(--color-text)">${label}</div>`;
const opt = (label: string) => ({ label, description: `${label} desc`, preview: frag(label) });

const visual = (header: string, labels: string[], multiSelect = false): Question => ({
  question: `${header}?`, header, domain: "ux", multiSelect, options: labels.map(opt),
});
const plain: Question = { question: "Plain?", header: "Plain", domain: "arch", options: [{ label: "X" }, { label: "Y" }] };

declare global {
  interface Window {
    // Must stay identical to auq-flow.view.spec.ts's declaration (TS2717).
    __auqResult?: { submitted?: Record<string, string | string[]>; cancelled?: boolean; extra?: string };
  }
}

async function openCard(page: Page, questions: Question[]): Promise<void> {
  await mountView(page);
  await page.evaluate(async (qs) => {
    const mod = await import("/views/sessions/permission-modal/question-ui.ts");
    window.__auqResult = {};
    mod.renderQuestionUI({
      questions: qs,
      titleIcon: "ph-chat-circle-dots",
      submitLabel: "Submit",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      onSubmit: (answers) => { window.__auqResult!.submitted = answers; },
      onCancel: () => { window.__auqResult!.cancelled = true; },
    });
  }, questions);
  await page.locator(".prompt-card").waitFor();
}

const fs = ".auq-fs";
const fsLabel = (page: Page) => page.locator(`${fs} .auq-fs__label`).textContent();
const fsProbe = (page: Page) => page.frameLocator(`${fs} .auq-fs__frame`).locator(".probe");
const activePanel = (page: Page) =>
  page.evaluate(() => Number(document.querySelector<HTMLElement>(".prompt-panel.is-active")?.dataset.panel));
const pickedAt = (page: Page, qi: number) =>
  page.evaluate((qi) => Array.from(document.querySelectorAll<HTMLInputElement>(`.prompt-panel[data-panel="${qi}"] .prompt-opt > input:checked`)).map((i) => i.dataset.label), qi);

test.describe("view-harness / AUQ fullscreen preview", () => {
  test("desktop: a tile opens fullscreen at the full view size, arrows page, Select advances", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openCard(page, [visual("First", ["A", "B", "C"]), visual("Second", ["D", "E"]), plain]);

    await page.locator(".prompt-panel.is-active .prompt-opt__pic").nth(1).click();
    await expect(page.locator(fs)).toBeVisible();
    await expect.poll(() => fsLabel(page)).toBe("B");
    await expect(fsProbe(page)).toHaveText("B");
    await expect(page.locator(`${fs} .auq-fs__qcount`)).toHaveText("1/3");

    // Not cropped: the frame fills everything between the two bars.
    const frame = await page.locator(`${fs} .auq-fs__frame`).boundingBox();
    expect(frame!.width).toBeGreaterThan(DESKTOP.width - 4);
    expect(frame!.height).toBeGreaterThan(DESKTOP.height - 200);

    await page.locator(`${fs} [data-fs="next"]`).click();
    await expect.poll(() => fsLabel(page)).toBe("C");
    await expect(page.locator(`${fs} [data-fs="next"]`)).toBeDisabled();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => fsLabel(page)).toBe("B");
    await page.screenshot({ path: ".for_bepy/screenshots/_specs/auq-preview-fullscreen-desktop.png" });

    // Select picks B and moves to question 2, which has previews: still fullscreen.
    await page.locator(`${fs} [data-fs="select"]`).click();
    await expect(page.locator(`${fs} .auq-fs__qcount`)).toHaveText("2/3");
    await expect.poll(() => fsLabel(page)).toBe("D");
    expect(await pickedAt(page, 0)).toEqual(["B"]);
    expect(await activePanel(page)).toBe(1);

    // Question 3 has no previews: back to the normal card on it.
    await page.locator(`${fs} [data-fs="select"]`).click();
    await expect(page.locator(fs)).toHaveCount(0);
    await expect.poll(() => activePanel(page)).toBe(2);
    expect(await pickedAt(page, 1)).toEqual(["D"]);
    expect(await page.evaluate(() => window.__auqResult?.submitted)).toBeUndefined();
  });

  test("back steps to the previous question, X returns to the card on the same one", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openCard(page, [visual("First", ["A", "B"]), visual("Second", ["C", "D"])]);

    await page.locator(".prompt-panel.is-active .prompt-opt__pic").first().click();
    await page.locator(`${fs} [data-fs="select"]`).click();
    await expect(page.locator(`${fs} .auq-fs__qcount`)).toHaveText("2/2");

    await page.locator(`${fs} [data-fs="back"]`).click();
    await expect(page.locator(`${fs} .auq-fs__qcount`)).toHaveText("1/2");
    // Re-entering a question shows its current pick.
    await expect.poll(() => fsLabel(page)).toBe("A");
    expect(await activePanel(page)).toBe(0);

    await page.locator(`${fs} [data-fs="close"]`).click();
    await expect(page.locator(fs)).toHaveCount(0);
    expect(await activePanel(page)).toBe(0);

    // Escape closes too, and never skips the question.
    await page.locator(".prompt-panel.is-active .prompt-opt__pic").first().click();
    await page.keyboard.press("Escape");
    await expect(page.locator(fs)).toHaveCount(0);
    expect(await page.evaluate(() => window.__auqResult?.cancelled)).toBeUndefined();
  });

  test("multi-select: Select toggles, Next moves on once something is picked", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openCard(page, [visual("Many", ["A", "B", "C"], true), plain]);

    await page.locator(".prompt-panel.is-active .prompt-opt__pic").first().click();
    const select = page.locator(`${fs} [data-fs="select"]`);
    const next = page.locator(`${fs} [data-fs="advance"]`);
    await expect(next).toBeVisible();
    await expect(next).toBeDisabled();

    await select.click();
    await expect(select).toHaveAttribute("aria-pressed", "true");
    await page.locator(`${fs} [data-fs="next"]`).click();
    await select.click();
    expect(await pickedAt(page, 0)).toEqual(["A", "B"]);
    await select.click();
    expect(await pickedAt(page, 0)).toEqual(["A"]);

    await expect(next).toBeEnabled();
    await next.click();
    await expect(page.locator(fs)).toHaveCount(0);
    await expect.poll(() => activePanel(page)).toBe(1);
  });

  test("the thumbnail strip jumps to an option and marks the picked one", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openCard(page, [visual("First", ["A", "B", "C"], true)]);
    await page.locator(".prompt-panel.is-active .prompt-opt__pic").first().click();

    const thumbs = page.locator(`${fs} .auq-fs__thumb`);
    await expect(thumbs).toHaveCount(3);
    await expect(page.frameLocator(`${fs} [data-fs-thumb="2"] .auq-fs__thumb-frame`).locator(".probe")).toHaveText("C");

    await thumbs.nth(2).click();
    await expect.poll(() => fsLabel(page)).toBe("C");
    await expect(fsProbe(page)).toHaveText("C");
    await expect(thumbs.nth(2)).toHaveClass(/is-current/);

    await expect(thumbs.nth(2).locator(".auq-fs__thumb-pick")).toBeHidden();
    await page.locator(`${fs} [data-fs="select"]`).click();
    await expect(thumbs.nth(2).locator(".auq-fs__thumb-pick")).toBeVisible();
    await expect(thumbs.nth(0).locator(".auq-fs__thumb-pick")).toBeHidden();
  });

  test("option text floats over the preview, and hiding it is remembered across cards", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openCard(page, [visual("First", ["A", "B"])]);
    await page.evaluate(() => localStorage.removeItem("cc.auqFullscreen.optionText"));
    await page.locator(".prompt-panel.is-active .prompt-opt__pic").first().click();

    const desc = page.locator(`${fs} .auq-fs__desc`);
    await expect(desc).toBeVisible();
    await expect(desc).toHaveText("A desc");
    // Over the preview, not taking height from it.
    const view = await page.locator(`${fs} .auq-fs__view`).boundingBox();
    const box = await desc.boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(view!.y + view!.height);

    await page.locator(`${fs} [data-fs="text"]`).click();
    await expect(desc).toBeHidden();
    await expect(page.locator(`${fs} [data-fs="text"]`)).toHaveAttribute("aria-pressed", "false");

    // A new card starts with the text hidden.
    await page.locator(`${fs} [data-fs="close"]`).click();
    await openCard(page, [visual("Again", ["X", "Y"])]);
    await page.locator(".prompt-panel.is-active .prompt-opt__pic").first().click();
    await expect(page.locator(`${fs} .auq-fs__desc`)).toBeHidden();
    await page.locator(`${fs} [data-fs="text"]`).click();
    await expect(page.locator(`${fs} .auq-fs__desc`)).toHaveText("X desc");
    await page.screenshot({ path: ".for_bepy/screenshots/_specs/auq-preview-fullscreen-text.png" });
  });

  test("wheel zooms the preview in", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openCard(page, [visual("First", ["A", "B"])]);
    await page.locator(".prompt-panel.is-active .prompt-opt__pic").first().click();
    const view = page.locator(`${fs} .auq-fs__view`);
    await view.hover();
    await page.mouse.wheel(0, -300);
    await expect.poll(() => page.locator(`${fs} .auq-fs__canvas`).evaluate((el) => el.style.transform)).toMatch(/scale\((?!1\))/);
  });

  test.describe("phone", () => {
    test.use({ hasTouch: true });

    test("tapping the stage opens fullscreen; a sideways drag pages options", async ({ page }) => {
      await page.setViewportSize(PHONE);
      await openCard(page, [visual("First", ["A", "B", "C"])]);

      await page.locator(".prompt-panel.is-active .prompt-stage__hit").click();
      await expect(page.locator(fs)).toBeVisible();
      await expect.poll(() => fsLabel(page)).toBe("A");
      expect(await pickedAt(page, 0)).toEqual([]);

      const view = await page.locator(`${fs} .auq-fs__view`).boundingBox();
      const y = view!.y + view!.height / 2;
      await page.mouse.move(view!.x + 300, y);
      await page.mouse.down();
      await page.mouse.move(view!.x + 150, y, { steps: 5 });
      await page.mouse.move(view!.x + 60, y, { steps: 5 });
      await page.mouse.up();
      await expect.poll(() => fsLabel(page)).toBe("B");
      // Only the shown option's thumbnail is outlined (polled: buttons
      // transition their border colour).
      const borders = () => page.locator(`${fs} .auq-fs__thumb`).evaluateAll((els) => els.map((el) => getComputedStyle(el).borderTopColor));
      await expect.poll(async () => { const b = await borders(); return b[0] === b[2] && b[1] !== b[0]; }).toBe(true);

      // The action buttons get their own full-width row on a phone.
      const select = await page.locator(`${fs} [data-fs="select"]`).boundingBox();
      expect(select!.width).toBeGreaterThan(PHONE.width - 60);
      await page.screenshot({ path: ".for_bepy/screenshots/_specs/auq-preview-fullscreen-phone.png" });

      // Single question, no review panel: Select picks and returns to the card,
      // where Submit is.
      await page.locator(`${fs} [data-fs="select"]`).click();
      await expect(page.locator(fs)).toHaveCount(0);
      expect(await pickedAt(page, 0)).toEqual(["B"]);
    });
  });
});
