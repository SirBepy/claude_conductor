// asserts: src/views/sessions/permission-modal/question-state.ts
// asserts: src/views/sessions/permission-modal/option-previews.ts
import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";

// pc-1787: a `ux` question whose options all carry the one same picture drew it
// once per option (Joe, 2026-11-19). The card now draws it once, as the
// question's own picture, and options whose pictures differ keep their own.
// Drives extractQuestions -> the real renderQuestionUI, in dark and light.

const frag = (label: string) =>
  `<div class="probe" style="padding:10px;background:var(--color-surface);color:var(--color-text)">${label}</div>`;
const SHARED = frag("the screen under discussion");

type RawQuestion = Record<string, unknown>;

const sharedOnOptions: RawQuestion = {
  question: "Is this good?",
  domain: "ux",
  options: [
    { label: "Good", badges: ["recommended"], preview: SHARED },
    { label: "Change something", preview: SHARED },
  ],
};
const sharedAlsoOnQuestion: RawQuestion = { ...sharedOnOptions, preview: SHARED };
const differing: RawQuestion = {
  question: "Which marker?",
  domain: "ux",
  options: [
    { label: "Dot", preview: frag("a dot") },
    { label: "Ring", preview: frag("a ring") },
    { label: "Plain" },
  ],
};

// `raw` = the pre-fix card: the payload handed to the renderer as it arrived.
async function openCard(page: Page, input: RawQuestion, mode: "dark" | "light", raw = false): Promise<void> {
  await mountView(page);
  await page.evaluate(({ m }) => {
    document.documentElement.dataset.theme = m === "light" ? "nord" : "void";
    document.documentElement.dataset.mode = m;
  }, { m: mode });
  await page.evaluate(async ({ input, raw }) => {
    const mod = await import("/views/sessions/permission-modal/question-ui.ts");
    const qs = raw ? [input] : mod.extractQuestions({ questions: [input] })!;
    mod.renderQuestionUI({
      questions: qs as never,
      submitLabel: "Submit",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      onSubmit: () => {},
      onCancel: () => {},
    });
  }, { input, raw });
  await page.locator(".prompt-card").waitFor();
  // Frames fill from srcdoc, so wait until they have laid out before a still.
  await page.waitForTimeout(400);
}

const active = ".prompt-panel.is-active";
const optPics = (page: Page) => page.locator(`${active} .prompt-opt__pic`);
const qPics = (page: Page) => page.locator(`${active} .prompt-qpic`);

async function still(page: Page, name: string): Promise<void> {
  const dir = process.env.UX_OPTIONS_STILLS;
  if (dir) await page.locator(".prompt-card").screenshot({ path: `${dir}/${name}.png` });
}

for (const mode of ["dark", "light"] as const) {
  test.describe(`view-harness / AUQ shared option preview (${mode})`, () => {
    test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1280, height: 1000 }); });

    test("one image on every option is drawn once, as the question's picture", async ({ page }) => {
      await openCard(page, sharedOnOptions, mode);
      await expect(qPics(page)).toHaveCount(1);
      await expect(optPics(page)).toHaveCount(0);
      await expect(page.locator(`${active} .prompt-opt`)).toHaveCount(2);
      await still(page, `after-shared-${mode}`);
    });

    test("the pre-fix card repeats it per option (what the dedupe replaces)", async ({ page }) => {
      await openCard(page, sharedOnOptions, mode, true);
      await expect(optPics(page)).toHaveCount(2);
      await still(page, `before-shared-${mode}`);
    });

    test("an image the question already shows is not drawn again on the options", async ({ page }) => {
      await openCard(page, sharedAlsoOnQuestion, mode);
      await expect(qPics(page)).toHaveCount(1);
      await expect(optPics(page)).toHaveCount(0);
    });

    test("options whose pictures really differ keep their own, the unpictured one stays plain", async ({ page }) => {
      await openCard(page, differing, mode);
      await expect(optPics(page)).toHaveCount(2);
      await expect(qPics(page)).toHaveCount(0);
      await expect(page.locator(`${active} .prompt-opt`)).toHaveCount(3);
      await still(page, `after-differing-${mode}`);
    });

    test("a plain option still picks after the dedupe", async ({ page }) => {
      await openCard(page, sharedOnOptions, mode);
      await page.locator(`${active} .prompt-opt`, { hasText: "Change something" }).click();
      const picked = await page.evaluate(
        () => document.querySelector<HTMLInputElement>(".prompt-panel.is-active .prompt-opt > input:checked")?.dataset.label ?? null,
      );
      expect(picked).toBe("Change something");
    });
  });
}
