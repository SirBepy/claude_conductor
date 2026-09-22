import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { mountView } from "./harness";

// Characters revamp (todo: cards keyboard+motion, letter-tile avatar fallback,
// slot-fill dots, themed New-character modal, empty/loading states, detail
// slot icons + aria-pressed play buttons). See src/views/characters/.

const SHOT_DIR = path.join(
  process.cwd(),
  ".for_bepy",
  "screenshots",
  "61363-Thu Sep 17 23:37:07 2026",
);
mkdirSync(SHOT_DIR, { recursive: true });

const ALL_SLOTS = ["work_finished", "question_asked", "ready", "select", "annoyed", "death"];

function slotsFilledUpTo(n: number): Record<string, string[]> {
  const slots: Record<string, string[]> = {};
  ALL_SLOTS.forEach((s, i) => {
    if (i < n) slots[s] = [`${s}-voice.mp3`];
  });
  return slots;
}

// 3 game groups x 2 characters, filled counts spanning 0/6 to 6/6, one very
// long label. All icons resolve to null (character_asset_url below) so every
// card's avatar never resolves - the letter-tile fallback path this revamp adds.
const CHARACTERS = [
  {
    id: "illidan",
    label: "Illidan Stormrage the Betrayer of Azeroth and Beyond, Extremely Long Name Edition",
    version: 1,
    icon: "icon.png",
    game: "wow",
    game_label: "World of Warcraft",
    slots: slotsFilledUpTo(4),
  },
  {
    id: "jaina",
    label: "Jaina",
    version: 2,
    icon: "icon.png",
    game: "wow",
    game_label: "World of Warcraft",
    slots: slotsFilledUpTo(2),
  },
  {
    id: "kerrigan",
    label: "Kerrigan",
    version: 1,
    icon: "icon.png",
    game: "sc2",
    game_label: "StarCraft II",
    slots: slotsFilledUpTo(0),
  },
  {
    id: "raynor",
    label: "Raynor",
    version: 1,
    icon: "icon.png",
    game: "sc2",
    game_label: "StarCraft II",
    slots: slotsFilledUpTo(5),
  },
  {
    id: "diablo",
    label: "Diablo",
    version: 3,
    icon: "icon.png",
    game: "diablo",
    game_label: "Diablo",
    slots: slotsFilledUpTo(6),
  },
  {
    id: "tyrael",
    label: "Tyrael",
    version: 1,
    icon: "icon.png",
    game: "diablo",
    game_label: "Diablo",
    slots: slotsFilledUpTo(1),
  },
];

const BASE_INVOKE = {
  character_asset_url: null,
  get_characters_dir: "/tmp/characters",
  preview_character_file: null,
  stop_character_preview: null,
};

async function mountCharacters(page: Page, chars: unknown[] = CHARACTERS) {
  await mountView(page, {
    view: "characters",
    invoke: { ...BASE_INVOKE, list_characters: chars },
  });
}

async function shotBothViewports(page: Page, label: string) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: path.join(SHOT_DIR, `${label}-1280x800.png`) });
  await page.setViewportSize({ width: 960, height: 640 });
  await page.screenshot({ path: path.join(SHOT_DIR, `${label}-960x640.png`) });
}

test.describe("view-harness / characters", () => {
  test("populated list: 3 game groups, varied fill, letter-tile fallback, no overflow", async ({ page }) => {
    await mountCharacters(page);
    await page.locator(".char-card").first().waitFor();

    await expect(page.locator(".char-group")).toHaveCount(3);
    await expect(page.locator(".char-card")).toHaveCount(6);

    // 0/6 character: every dot unfilled, title names all six slots.
    const kerriganDots = page.locator('.char-card:has-text("Kerrigan") .char-card-dots');
    await expect(kerriganDots.locator(".char-dot.filled")).toHaveCount(0);
    await expect(kerriganDots).toHaveAttribute("title", /Missing: work finished, question asked, ready, select, annoyed, death/);

    // 6/6 character: every dot filled.
    const diabloDots = page.locator('.char-card:has-text("Diablo") .char-card-dots');
    await expect(diabloDots.locator(".char-dot.filled")).toHaveCount(6);
    await expect(diabloDots).toHaveAttribute("title", "All slots filled");

    // Every avatar box (including the very-long-name card) clips its content -
    // the CONFIRMED broken-image overflow bug this revamp fixes.
    const boxes = page.locator(".char-card-avatar-box");
    const count = await boxes.count();
    expect(count).toBe(6);
    for (let i = 0; i < count; i++) {
      const box = boxes.nth(i);
      const overflowing = await box.evaluate(
        (el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
      );
      expect(overflowing).toBe(false);
      // No character's icon resolves in this fixture, so the fallback letter
      // tile must be the visible content (image stays at opacity 0).
      const imgOpacity = await box.locator(".char-card-avatar").evaluate((el) => getComputedStyle(el).opacity);
      expect(imgOpacity).toBe("0");
      await expect(box.locator(".char-avatar-fallback")).toBeVisible();
    }

    // The 7-line Illidan name is clamped to 2 lines, so its card matches
    // Jaina's height in the same group instead of ballooning past it.
    const illidanHeight = await page.locator('.char-card:has-text("Illidan")').evaluate((el) => el.getBoundingClientRect().height);
    const jainaHeight = await page.locator('.char-card:has-text("Jaina")').evaluate((el) => el.getBoundingClientRect().height);
    expect(Math.abs(illidanHeight - jainaHeight)).toBeLessThanOrEqual(1);

    await shotBothViewports(page, "characters-after-populated");
  });

  test("empty state shows the v-empty card with the character-creator hint", async ({ page }) => {
    await mountCharacters(page, []);
    await expect(page.locator(".v-empty")).toBeVisible();
    await expect(page.locator(".v-empty-title")).toHaveText("No characters yet");
    await expect(page.locator(".v-empty-hint")).toContainText("/character-creator");
    await expect(page.locator(".char-card")).toHaveCount(0);

    await shotBothViewports(page, "characters-after-empty");
  });

  test("a card is keyboard-operable: focus + Enter opens the detail view", async ({ page }) => {
    await mountCharacters(page);
    const card = page.locator('.char-card:has-text("Diablo")');
    await card.waitFor();
    await expect(card).toHaveAttribute("role", "button");
    await expect(card).toHaveAttribute("tabindex", "0");

    await card.focus();
    await page.keyboard.press("Enter");

    await expect(page.locator(".view-character-detail h2")).toHaveText("Diablo");
  });

  test("detail view: slot icons render and a play button's aria-pressed toggles", async ({ page }) => {
    await mountCharacters(page);
    await page.locator('.char-card:has-text("Diablo")').click();
    await page.locator(".char-slot-row").first().waitFor();

    await expect(page.locator(".view-character-detail .section-title")).toHaveText("Slots");
    // work_finished is the first slot and Diablo has it filled.
    const firstIcon = page.locator(".char-slot-row").first().locator(".char-slot-icon");
    await expect(firstIcon).toHaveClass(/ph-check-circle/);
    await expect(firstIcon).toHaveClass(/filled/);

    const playBtn = page.locator(".char-play-btn").first();
    await expect(playBtn).toHaveAttribute("aria-pressed", "false");
    await playBtn.click();
    await expect(playBtn).toHaveAttribute("aria-pressed", "true");
    await expect(playBtn).toHaveClass(/v-pulse/);

    await playBtn.click();
    await expect(playBtn).toHaveAttribute("aria-pressed", "false");
    await expect(playBtn).not.toHaveClass(/v-pulse/);

    await shotBothViewports(page, "character-detail-after");
  });

  test("New-character modal opens from the kebab menu and closes on Escape", async ({ page }) => {
    await mountCharacters(page);
    await page.locator(".char-card").first().waitFor();

    await page.locator("#characters-more").click();
    await page.locator("#characters-create-new").click();

    const modal = page.locator('[role="dialog"][aria-label="New character"]');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("New character");
    await expect(modal.locator("code")).toContainText("/character-creator");

    await shotBothViewports(page, "characters-after-modal");

    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
  });

  test("delight: card hover-lift rule exists in a loaded stylesheet", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mountCharacters(page);
    await page.locator(".char-card").first().waitFor();

    // Hover on :hover pseudo-class is flaky to read back as computed style;
    // asserting the rule is actually in a loaded stylesheet is not.
    const hoverRuleExists = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        for (const rule of Array.from(rules)) {
          const text = rule.cssText ?? "";
          if (text.includes(".char-card:hover .char-card-avatar-box") && text.includes("rotate")) {
            return true;
          }
        }
      }
      return false;
    });
    expect(hoverRuleExists).toBe(true);

    await page.screenshot({ path: path.join(SHOT_DIR, "characters-delight-populated-1280.png") });
  });

  test("delight: reduced motion disables the empty-icon idle float", async ({ page }) => {
    // Own page/fresh navigation, not a second mountView() on a page already at
    // the same hash - a same-URL goto() can no-op and serve the stale module cache.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mountCharacters(page, []);
    await page.locator(".v-empty-icon").waitFor();
    // A real keyframe animation (animation-name), so this is a clean
    // computed-style read unlike a hover transform.
    const reducedName = await page.locator(".v-empty-icon").evaluate((el) => getComputedStyle(el).animationName);
    expect(reducedName).toBe("none");
  });

  test("delight: preview reward bobs the hero avatar while playing", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mountCharacters(page);
    await page.locator('.char-card:has-text("Diablo")').click();
    await page.locator(".char-slot-row").first().waitFor();

    const heroBox = page.locator(".char-detail-avatar-box");
    const playBtn = page.locator(".char-play-btn").first();
    await playBtn.click();
    await expect(heroBox).toHaveClass(/playing/);
    const animName = await heroBox.evaluate((el) => getComputedStyle(el).animationName);
    expect(animName).toBe("char-preview-bob");

    await page.screenshot({ path: path.join(SHOT_DIR, "character-detail-delight-1280.png") });
  });
});
