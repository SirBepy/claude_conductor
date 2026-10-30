import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";
import { shotDir } from "./shot-dir";

// Per-project skill scope, driven through the rendered UI: the
// Skills list's "Available in" line, the scope editor on a skill's page saving
// `skillScopes`, and the composer's warning plus Enter-enables flow for a
// /skill that is off in the chat's project.

const SHOT_DIR = shotDir();

const PROJECTS = [
  { id: "p1", name: "zng-app", path: "C:/Projects/zng" },
  { id: "p2", name: "cueline", path: "C:/Projects/cue" },
  { id: "p3", name: "dashboard-a", path: "C:/Projects/dash" },
  { id: "p4", name: "alpha", path: "C:/Projects/alpha" },
];

const SCOPES = {
  "figma-tiles": { projects: ["p1", "p2", "p3"], elsewhere: "off" },
  "figma@claude-plugins-official": { projects: ["p1"], elsewhere: "off" },
};

const SKILLS = [
  { skill: "commit", description: "Commits changes.", plugin: null, project: null, scope_key: "commit" },
  { skill: "figma-tiles", description: "Turns a Figma board into per-screen tiles.", plugin: null, project: null, scope_key: "figma-tiles" },
  { skill: "figma:figma-use", description: "Read and edit Figma designs.", plugin: "figma", project: null, scope_key: "figma@claude-plugins-official" },
  { skill: "code-check", description: "Structural review.", plugin: null, project: "alpha", scope_key: null },
];

const settings = { theme: "catppuccin", skillScopes: SCOPES };

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOT_DIR, `skill-scope-${name}.png`) });
}

test.describe("view-harness / skill scope", () => {
  test("Skills list shows where a scoped skill is available", async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 560 });
    await mountView(page, {
      view: "skills",
      invoke: { list_installed_skills: SKILLS, list_projects: PROJECTS, get_settings: settings },
    });
    await page.locator(".skills-list li").first().waitFor();
    await expect(page.locator('.skills-list li[title="figma-tiles"] .skill-where')).toHaveText("3 projects");
    await expect(page.locator('.skills-list li[title="figma:figma-use"] .skill-where')).toHaveText("zng-app");
    await expect(page.locator('.skills-list li[title="commit"] .skill-where')).toHaveCount(0);
    await shot(page, "list");
  });

  test("the scope editor saves projects and the elsewhere level", async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 560 });
    await mountView(page, {
      view: "skills",
      invoke: {
        list_installed_skills: SKILLS,
        list_projects: PROJECTS,
        get_settings: settings,
        get_skill_usage_detail: { skill: "figma-tiles", invocations: { total: 7, manual: 5, skill: 2, auto: 0 }, events: [] },
      },
    });
    await page.locator('.skills-list li[title="figma-tiles"]').click();
    const box = page.locator(".skill-scope");
    await expect(box).toBeVisible();
    await expect(box.locator(".skill-scope-chip")).toHaveText(["zng-app", "cueline", "dashboard-a"]);
    await shot(page, "detail");

    await box.locator(".skill-scope-add").click();
    await expect(box.locator(".skill-scope-menu div")).toHaveText(["alpha"]);
    await shot(page, "detail-add");
    await box.locator(".skill-scope-menu div").click();
    await box.getByRole("button", { name: "Name only" }).click();

    await expect.poll(async () => {
      const saves = (await invokeCalls(page)).filter((c) => c.cmd === "save_settings");
      const last = saves[saves.length - 1]?.args as { updated?: { skillScopes?: Record<string, unknown> } } | undefined;
      return last?.updated?.skillScopes?.["figma-tiles"];
    }).toEqual({ projects: ["p1", "p2", "p3", "p4"], elsewhere: "name-only" });

    await box.getByRole("button", { name: "Every project" }).click();
    await expect(box.locator(".skill-scope-chips")).toHaveCount(0);
  });

  test("a plugin skill's page scopes the whole plugin", async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 560 });
    await mountView(page, {
      view: "skills",
      invoke: {
        list_installed_skills: SKILLS,
        list_projects: PROJECTS,
        get_settings: settings,
        get_skill_usage_detail: { skill: "figma:figma-use", invocations: { total: 0, manual: 0, skill: 0, auto: 0 }, events: [] },
      },
    });
    await page.locator('.skills-list li[title="figma:figma-use"]').click();
    const box = page.locator(".skill-scope");
    await expect(box).toContainText("Applies to the whole figma plugin");
    await expect(box.getByRole("button", { name: "Name only" })).toHaveCount(0);
    await shot(page, "plugin");
  });

  test("typing a skill that is off here warns, and Enter enables it then sends", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 640 });
    const sess = sessionInstance({ busy: false, awaiting: "done" });
    const entry = (name: string, off_here: boolean, extra: Record<string, unknown> = {}) => ({
      name, args: null, description: `${name}: does the ${name} thing`, source: { kind: "user-skill" },
      path: null, menu_hidden: false, scope_key: name, off_here, ...extra,
    });
    await mountView(page, {
      view: "sessions",
      invoke: {
        ...SESSIONS_BASE_INVOKE,
        get_settings: { theme: "catppuccin" },
        list_instances: [sess],
        get_active_sessions: [sess],
        list_project_files: [],
        list_slash_commands: [
          entry("figma-pixel-diff", false),
          entry("figma-tiles", true),
          entry("figma-use", true, { source: { kind: "plugin-skill", plugin: "figma" }, scope_key: "figma@claude-plugins-official" }),
        ],
        enable_skill_here: true,
        send_message: null,
      },
    });
    await page.locator("#sessions-list li[data-session-id]").first().click();
    const composer = page.locator("#session-pane .session-composer").first();
    const ta = composer.locator(".composer-textarea");
    await ta.waitFor();

    await ta.pressSequentially("/fig");
    const rows = composer.locator(".caret-popup .row");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).not.toHaveClass(/off-here/);
    await expect(rows.nth(2)).toHaveClass(/off-here/);
    await expect(rows.nth(2).locator(".off-here-tag")).toHaveText("off in this project");
    await shot(page, "popup");

    await ta.fill("/figma-tiles export the onboarding board");
    const warn = composer.locator(".composer-scope-warning");
    await expect(warn).toBeVisible();
    await expect(warn).toContainText("/figma-tiles is off in this project.");
    await shot(page, "warning");

    await ta.press("Enter");
    await expect.poll(async () => (await invokeCalls(page)).map((c) => c.cmd).filter((c) => c === "enable_skill_here" || c === "send_message"))
      .toEqual(["enable_skill_here", "send_message"]);
    const enable = (await invokeCalls(page)).find((c) => c.cmd === "enable_skill_here");
    expect(enable?.args).toEqual({ projectDir: "C:/Projects/alpha", key: "figma-tiles", sessionId: "s1" });
    await expect(composer.locator(".composer-notice")).toHaveText("/figma-tiles is now enabled in this project.");
    await shot(page, "enabled");
  });
});
