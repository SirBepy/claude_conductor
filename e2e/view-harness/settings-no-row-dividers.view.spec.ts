import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { mountView } from "./harness";
import { shotDir } from "./shot-dir";

// asserts: src/styles/settings-sections.css, src/views/settings/subviews/shortcuts/shortcuts.css, src/views/settings/subviews/permissions/permissions.css, src/views/characters/character-detail.css, src/views/sessions/project-dashboard/project-config/automation.ts
// Settings cards draw no hairline between rows. The kit's per-row divider
// skipped only a card's :last-of-type row, so a row followed by a caption or a
// button kept its line and cards showed lines under some rows and not others.
// Shortcuts, Permissions and Character detail style their own row classes, so
// each needs its own check: the kit rule does not reach them.
// The project-config automation popup reuses the Settings .option rows and goes
// without lines too, so the one unscoped .option rule stays gone for it as well.

const SHOT_DIR = shotDir();
const LABEL = process.env.CC_SHOT_LABEL ?? "after";

async function rowBorders(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((els) =>
    els.map((el) => {
      const cs = getComputedStyle(el);
      return {
        label: el.textContent?.trim().slice(0, 40) || el.className,
        top: cs.borderTopWidth,
        bottom: cs.borderBottomWidth,
      };
    }),
  );
}

function expectNoDividers(rows: { label: string; top: string; bottom: string }[], minRows: number) {
  expect(rows.length).toBeGreaterThanOrEqual(minRows);
  for (const r of rows) {
    expect(r.bottom, `row "${r.label}" bottom border`).toBe("0px");
    expect(r.top, `row "${r.label}" top border`).toBe("0px");
  }
}

test("settings rows draw no divider lines", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  await mountView(page, { view: "settings-appearance" });
  await page.locator(".kit-row").first().waitFor();

  const rows = await page.locator(".kit-row, .option").evaluateAll((els) =>
    els.map((el) => {
      const cs = getComputedStyle(el);
      return {
        label: el.querySelector(".kit-row-label")?.textContent?.trim() ?? el.className,
        top: cs.borderTopWidth,
        bottom: cs.borderBottomWidth,
      };
    }),
  );
  await page.screenshot({ path: path.join(SHOT_DIR, `settings-no-row-dividers-${LABEL}.png`), fullPage: true });

  expect(rows.length).toBeGreaterThan(1);
  for (const r of rows) {
    expect(r.bottom, `row "${r.label}" bottom border`).toBe("0px");
    expect(r.top, `row "${r.label}" top border`).toBe("0px");
  }
});

test("shortcut rows draw no divider lines", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  await mountView(page, { view: "settings-shortcuts" });
  await page.locator(".shortcut-row").first().waitFor();

  expectNoDividers(await rowBorders(page, ".shortcut-row"), 2);
});

test("permission rule rows draw no divider lines", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  await mountView(page, {
    view: "settings-permissions",
    invoke: {
      // Rules are stored as "<Tool>::<pattern>" under their project's cwd.
      get_settings: {
        projectPermissionRules: {
          "C:/work/demo": ["Bash::git status", "Bash::pnpm test", "Read::C:/work/demo/a.txt"],
        },
      },
    },
  });
  await page.locator(".perm-rule").first().waitFor();

  expectNoDividers(await rowBorders(page, ".perm-rule"), 2);
});

test("character detail slot rows draw no divider lines", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  const slots = Object.fromEntries(
    ["work_finished", "question_asked", "ready"].map((s) => [s, [`${s}-voice.mp3`]]),
  );
  await mountView(page, {
    view: "characters",
    invoke: {
      character_asset_url: null,
      get_characters_dir: "/tmp/characters",
      preview_character_file: null,
      stop_character_preview: null,
      list_characters: [
        { id: "diablo", label: "Diablo", version: 3, icon: "icon.png", game: "diablo", game_label: "Diablo", slots },
      ],
    },
  });
  await page.locator('.char-card:has-text("Diablo")').click();
  await page.locator(".char-slot-row").first().waitFor();

  expectNoDividers(await rowBorders(page, ".char-slot-row"), 2);
});

test("project config automation rows draw no divider lines", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  const cwd = "C:/work/demo";
  await mountView(page, {
    view: "settings-appearance",
    invoke: {
      list_accounts: [],
      resolve_project_account: null,
      get_ticket_tracker: null,
      // A project that already has automation, so the Enabled / Start on boot
      // rows are shown and not just the "Add automation" empty state.
      list_projects: [
        {
          id: "p1",
          path: cwd,
          automation: { enabled: false, autostart_on_boot: true, continue_flag: true, session_name_prefix: null },
        },
      ],
    },
  });
  await page.locator(".kit-row").first().waitFor();

  await page.evaluate(async (projectCwd) => {
    const { renderProjectSettings } = await import("/views/sessions/project-dashboard/project-config/automation.ts");
    const host = document.createElement("div");
    host.id = "project-config-host";
    document.body.appendChild(host);
    await renderProjectSettings(host, projectCwd);
  }, cwd);
  await page.locator("#project-config-host #automationForm").waitFor({ state: "visible" });

  expectNoDividers(await rowBorders(page, "#project-config-host .option"), 6);
});
