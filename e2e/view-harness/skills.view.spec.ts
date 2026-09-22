import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { mountView } from "./harness";

// Skills revamp: tokenized colors, keyboard-operable rows, plugin-prefix
// stripped from the display name, AA-contrast badges, and a distinct
// error state from a true-empty list. See src/views/skills/.

const SHOT_DIR = path.join(
  process.cwd(),
  ".for_bepy",
  "screenshots",
  "61363-Thu Sep 17 23:37:07 2026",
);
mkdirSync(SHOT_DIR, { recursive: true });

const LONG_DESC =
  "A very long description that should wrap onto more than two lines when rendered in the narrow skill row layout, so the line-clamp behavior can be verified by checking the rendered row height stays fixed regardless of how much text the skill author wrote for it.";

const TEN_SKILLS = [
  { skill: "commit", description: "Commits staged changes following the project's conventions.", plugin: null, project: null },
  { skill: "delete", description: "Deletes files or directories, picking the right tool per platform.", plugin: null, project: null },
  { skill: "superpowers:brainstorming", description: LONG_DESC, plugin: "superpowers", project: null },
  { skill: "superpowers:code-review", description: "Reviews a diff for correctness bugs.", plugin: "superpowers", project: null },
  { skill: "impeccable", description: "Design, redesign, or critique a frontend interface.", plugin: null, project: null },
  { skill: "rate-it", description: "Brutally honest 1-10 rating with named score tiers.", plugin: null, project: null },
  { skill: "code-check", description: "Structural and convention review of changed files.", plugin: null, project: "claude_usage_in_taskbar" },
  { skill: "ticket", description: "Files or updates a ticket in the repo's tracker.", plugin: null, project: "zng-app" },
  { skill: "readme", description: "Keeps README.md in sync with the codebase.", plugin: null, project: null },
  { skill: "screenshot", description: "Takes portfolio-quality screenshots of the current project.", plugin: null, project: null },
];

const SKILL_DETAIL_SEED = {
  skill: "commit",
  invocations: { total: 4, manual: 3, skill: 1, auto: 0 },
  events: [],
};

async function mountSkills(page: Page, skills: unknown[] = TEN_SKILLS) {
  await mountView(page, {
    view: "skills",
    invoke: { list_installed_skills: skills, get_skill_usage_detail: SKILL_DETAIL_SEED },
  });
}

async function shotBothViewports(page: Page, label: string) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: path.join(SHOT_DIR, `skills-after-${label}-1280x800.png`) });
  await page.setViewportSize({ width: 960, height: 640 });
  await page.screenshot({ path: path.join(SHOT_DIR, `skills-after-${label}-960x640.png`) });
}

test.describe("view-harness / skills", () => {
  test("populated: user/plugin/project mix, clamped description, prefix stripped", async ({ page }) => {
    await mountSkills(page);
    const rows = page.locator(".skills-list li");
    await rows.first().waitFor();
    await expect(rows).toHaveCount(10);
    await expect(page.locator(".skills-count")).toHaveText("10 of 10");

    // Plugin-prefixed skill renders without the prefix, keeps the full key as
    // the row title, and shows the plugin badge.
    const pluginRow = page.locator('.skills-list li[title="superpowers:brainstorming"]');
    await expect(pluginRow.locator(".skill-name")).toHaveText("brainstorming");
    await expect(pluginRow.locator(".skill-badge-plugin")).toHaveText("superpowers");

    // Personal and project badges use their tokenized labels.
    await expect(page.locator('.skills-list li[title="commit"] .skill-badge-personal')).toHaveText("personal");
    await expect(page.locator('.skills-list li[title="code-check"] .skill-badge-project')).toHaveText("claude_usage_in_taskbar");

    // Long description is clamped to 2 lines but keeps the full text as a title.
    const clampedDesc = pluginRow.locator(".skill-desc");
    await expect(clampedDesc).toHaveAttribute("title", LONG_DESC);
    const lineClamp = await clampedDesc.evaluate((el) => getComputedStyle(el).webkitLineClamp);
    expect(lineClamp).toBe("2");

    // Rows are keyboard-operable.
    await expect(rows.first()).toHaveAttribute("role", "button");
    await expect(rows.first()).toHaveAttribute("tabindex", "0");

    await shotBothViewports(page, "populated");
  });

  test("empty state: no skills installed", async ({ page }) => {
    await mountSkills(page, []);
    await expect(page.locator(".v-empty .v-empty-title")).toHaveText("No skills installed");
    await expect(page.locator(".v-empty .v-empty-icon")).toHaveClass(/ph-puzzle-piece/);
    await expect(page.locator(".skills-list")).toHaveCount(0);

    await shotBothViewports(page, "empty");
  });

  test("error state: list_installed_skills failure shows a distinct retry state", async ({ page }) => {
    // list_installed_skills deliberately omitted from the invoke map: the
    // harness rejects any unmocked command, which is exactly the shape of a
    // real backend failure from the frontend's point of view.
    await mountView(page, { view: "skills", invoke: {} });

    const errorEmpty = page.locator(".v-empty");
    await expect(errorEmpty.locator(".v-empty-title")).toHaveText("Couldn't load skills");
    await expect(errorEmpty.locator(".v-empty-icon")).toHaveClass(/ph-warning/);
    const retryBtn = errorEmpty.locator(".skills-retry");
    await expect(retryBtn).toHaveClass(/btn-secondary/);
    await expect(retryBtn).toHaveText("Retry");
  });

  test("search filters by name/description/plugin/project, Escape clears and keeps focus", async ({ page }) => {
    await mountSkills(page);
    const search = page.locator("#skillsSearchInput");
    await expect(page.locator(".skills-list li")).toHaveCount(10);

    await search.fill("superpowers");
    await expect(page.locator(".skills-list li")).toHaveCount(2);
    await expect(page.locator(".skills-count")).toHaveText("2 of 10");

    await search.fill("zng-app");
    await expect(page.locator(".skills-list li")).toHaveCount(1);
    await expect(page.locator(".skills-count")).toHaveText("1 of 10");

    await search.press("Escape");
    await expect(search).toHaveValue("");
    await expect(page.locator(".skills-list li")).toHaveCount(10);
    await expect(search).toBeFocused();
  });

  test("keyboard path: Tab to a row, Enter navigates to skill-detail", async ({ page }) => {
    await mountSkills(page);
    const firstRow = page.locator(".skills-list li").first();
    await firstRow.waitFor();

    await page.locator("#skillsSearchInput").focus();
    await page.keyboard.press("Tab");
    await expect(firstRow).toBeFocused();

    await page.keyboard.press("Enter");
    await expect(page.locator(".view-skill-detail")).toBeVisible();
    await expect(page.locator(".view-skill-detail h2")).toHaveText("commit");

    // Back button returns to Skills, not Dashboard (the P0 fix).
    await page.locator(".view-skill-detail .icon-btn").first().click();
    await expect(page.locator(".view-skills")).toBeVisible();
  });
});
