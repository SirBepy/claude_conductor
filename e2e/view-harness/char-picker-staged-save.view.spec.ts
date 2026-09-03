import { expect, test, type Page } from "@playwright/test";
import { invokeCalls, mountView, SESSIONS_BASE_INVOKE } from "./harness";

// The picker used to apply a character the instant a card was clicked, which
// made auditioning voicelines impossible - every listen was a commit. Clicking
// now only stages (and plays); Save is what resolves.

const CHARS = ["Abathur", "Alarak", "Alexstrasza", "Ana", "Anduin"].map((label, i) => ({
  id: `c${i}`,
  label,
  version: 1,
  icon: "icon.png",
  game_label: "Heroes of the Storm",
  slots: {},
}));

const BASE_INVOKE = {
  ...SESSIONS_BASE_INVOKE,
  resolve_whitelist_characters: CHARS,
  list_characters: CHARS,
  character_asset_url: null,
  play_character_slot: null,
};

/** Mounts the sessions view and opens the picker, parking its resolved value on
 *  `window.__pick` ("pending" until it settles) so the test can assert on it. */
async function openPicker(page: Page, currentId: string | null = "c2") {
  await mountView(page, { view: "sessions", invoke: BASE_INVOKE });
  await page.evaluate(async (cur) => {
    const w = window as unknown as { __pick?: string | null | "pending" };
    w.__pick = "pending";
    const mod = await import("/shared/change-character-modal.ts");
    void mod.openChangeCharacterModal({ projectId: "proj1", currentId: cur }).then((r) => {
      w.__pick = r;
    });
  }, currentId);
  await page.locator(".cc-char-card").first().waitFor();
}

function pickResult(page: Page) {
  return page.evaluate(() => (window as unknown as { __pick?: string | null | "pending" }).__pick);
}

test("clicking a card stages the pick and plays it, without resolving", async ({ page }) => {
  await openPicker(page);
  await expect(page.locator(".cc-modal-pick-name")).toHaveText("Alexstrasza");

  await page.locator('.cc-char-card[data-char-id="c4"]').click();

  await expect(page.locator(".cc-modal-pick-name")).toHaveText("Anduin");
  await expect(page.locator('.cc-char-card[data-char-id="c4"]')).toHaveClass(/selected/);
  await expect(page.locator('.cc-char-card[data-char-id="c2"]')).not.toHaveClass(/selected/);
  await expect(page.locator(".cc-modal-card")).toBeVisible();
  expect(await pickResult(page)).toBe("pending");

  // The voiceline is debounced by 250ms inside the modal.
  await expect
    .poll(async () =>
      (await invokeCalls(page)).some(
        (c) => c.cmd === "play_character_slot" && (c.args as { characterId?: string })?.characterId === "c4",
      ),
    )
    .toBe(true);
});

test("Save resolves the staged pick, Cancel resolves null", async ({ page }) => {
  await openPicker(page);
  await page.locator('.cc-char-card[data-char-id="c1"]').click();
  await page.locator(".cc-modal-save").click();

  await expect.poll(() => pickResult(page)).toBe("c1");
  await expect(page.locator(".cc-modal-card")).toHaveCount(0);

  await openPicker(page, "c0");
  await page.locator('.cc-char-card[data-char-id="c3"]').click();
  await page.locator(".cc-modal-cancel").click();

  await expect.poll(() => pickResult(page)).toBe(null);
});

test("Random rerolls in place instead of closing", async ({ page }) => {
  await openPicker(page);
  await page.locator(".cc-modal-random").click();

  const staged = await page.locator(".cc-modal-pick-name").textContent();
  expect(staged).not.toBe("Alexstrasza"); // Random always skips the current pick
  await expect(page.locator(".cc-modal-card")).toBeVisible();
  expect(await pickResult(page)).toBe("pending");
});
