import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { mountView } from "./harness";
import { shotDir } from "./shot-dir";
import type { ProjectGroup } from "../../src/types/ipc.generated";

// Projects revamp (design critique: raw innerHTML -> lit-html, keyboard-
// unreachable cards, error-vs-empty indistinguishable, emoji status tags,
// no search, 2 of 4 sort modes hidden, footer button violating the header/
// kebab convention). See src/views/projects/.

const SHOT_DIR = shotDir("61363-Thu Sep 17 23:37:07 2026");

async function shotBothViewports(page: Page, label: string): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: path.join(SHOT_DIR, `${label}-1280x800.png`) });
  await page.setViewportSize({ width: 960, height: 640 });
  await page.screenshot({ path: path.join(SHOT_DIR, `${label}-960x640.png`) });
}

interface Fixture {
  name: string;
  path: string;
  parent_segment?: string | null;
  live?: number;
  any_remote?: boolean;
  any_automated?: boolean;
  tokens_7d?: number;
  last_active_at?: string | null;
}

// tokens_7d is ts-rs-typed bigint (src/types/ipc.generated.ts) but the wire
// value is a plain JSON number - the harness serializes invoke fixtures via
// JSON, and a real bigint throws "Do not know how to serialize a BigInt".
function group(f: Fixture): ProjectGroup {
  return {
    id: f.path,
    path: f.path,
    name: f.name,
    parent_segment: f.parent_segment ?? null,
    avatar: { kind: "emoji", value: "🗂" },
    automation_enabled: f.any_automated ?? false,
    tokens_7d: (f.tokens_7d ?? 0) as unknown as bigint,
    live: f.live ?? 0,
    any_remote: f.any_remote ?? false,
    any_automated: f.any_automated ?? false,
    last_active_at: f.last_active_at ?? null,
    path_exists: true,
    worktrees: [],
    last_worktree_path: null,
    last_start_folder_rel: null,
  };
}

const POPULATED: ProjectGroup[] = [
  group({ name: "Alpha", path: "/repos/alpha", tokens_7d: 12000, last_active_at: "2026-09-10T10:00:00Z" }),
  group({ name: "Beta", path: "/repos/beta", live: 2, tokens_7d: 4000, last_active_at: "2026-09-17T09:00:00Z" }),
  group({ name: "Gamma", path: "/repos/gamma", any_remote: true, tokens_7d: 800, last_active_at: "2026-09-16T08:00:00Z" }),
  group({ name: "Delta", path: "/repos/delta", any_automated: true, tokens_7d: 20000, last_active_at: "2026-09-15T08:00:00Z" }),
  group({
    name: "Epsilon",
    path: "/repos/epsilon",
    live: 1,
    any_remote: true,
    any_automated: true,
    tokens_7d: 500,
    last_active_at: "2026-09-14T08:00:00Z",
  }),
  group({
    name: "This Is An Extremely Long Project Name That Should Truncate With An Ellipsis Instead Of Wrapping",
    path: "/repos/very-long-name-project",
    tokens_7d: 100,
    last_active_at: "2026-09-13T08:00:00Z",
  }),
  group({ name: "api", path: "/repos/monorepo/api", parent_segment: "monorepo", tokens_7d: 300, last_active_at: "2026-09-12T08:00:00Z" }),
];

const BASE_INVOKE = {
  get_settings: { theme: "void", projects_sort_by: "recent" },
};

/** `groups === undefined` deliberately omits `list_project_groups` from the
 *  invoke map, so the harness's mock rejects it - the error-state trigger. */
async function mountProjects(
  page: Page,
  groups: ProjectGroup[] | undefined,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const invoke: Record<string, unknown> = { ...BASE_INVOKE, ...extra };
  if (groups !== undefined) invoke.list_project_groups = groups;
  await mountView(page, { view: "projects", invoke });
}

async function installNavSpy(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { navigateTo?: (n: string) => void; __navCalls?: string[] };
    w.__navCalls = [];
    w.navigateTo = (n: string) => { w.__navCalls!.push(n); };
  });
}

async function navCalls(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __navCalls?: string[] }).__navCalls ?? []);
}

test.describe("view-harness / projects", () => {
  test("populated list: varied live/remote/automated tags, long-name truncation, four sort options", async ({ page }) => {
    await mountProjects(page, POPULATED);
    await page.locator(".project-card").first().waitFor();
    await expect(page.locator(".project-card")).toHaveCount(7);

    // Not raw innerHTML markup: cards are keyboard-reachable.
    const first = page.locator(".project-card").first();
    await expect(first).toHaveAttribute("role", "button");
    await expect(first).toHaveAttribute("tabindex", "0");

    // Live tag: icon-free numeric dot chip, both title and aria-label set.
    const liveTag = page.locator('.project-card:has-text("Beta") .proj-tag-live');
    await expect(liveTag).toHaveAttribute("aria-label", "2 live");
    await expect(liveTag).toHaveAttribute("title", "2 live");

    // Remote + automated: Phosphor icon + short text label, never emoji.
    const remoteTag = page.locator('.project-card:has-text("Gamma") .proj-tag');
    await expect(remoteTag).toContainText("remote");
    await expect(remoteTag.locator("i.ph-device-mobile")).toBeAttached();

    const autoTag = page.locator('.project-card:has-text("Delta") .proj-tag');
    await expect(autoTag).toContainText("auto");
    await expect(autoTag.locator("i.ph-gear")).toBeAttached();

    // A project with all three tags together (Epsilon) renders all three chips.
    await expect(page.locator('.project-card:has-text("Epsilon") .proj-tag')).toHaveCount(3);

    // The worktree/parent-segment project shows its parent segment in the name.
    await expect(page.locator('.project-card:has-text("api")')).toContainText("monorepo");

    // Long-name card truncates instead of wrapping: same height as another
    // tag-free card (Alpha) - wrapping would grow just this one row.
    const longNameHeight = await page.locator('.project-card:has-text("Extremely Long")').evaluate((el) => el.getBoundingClientRect().height);
    const alphaHeight = await page.locator('.project-card:has-text("Alpha")').evaluate((el) => el.getBoundingClientRect().height);
    expect(Math.abs(longNameHeight - alphaHeight)).toBeLessThan(2);
    const longNameEl = page.locator('.project-card:has-text("Extremely Long") .name');
    const overflowing = await longNameEl.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(overflowing).toBe(true);

    // All four backend sort modes are exposed (only 2 of 4 were before this revamp).
    await expect(page.locator("#projectsSortSelect option")).toHaveCount(4);

    // No emoji status glyphs anywhere in a rendered card.
    const cardText = await page.locator(".projects-list").innerText();
    expect(cardText).not.toMatch(/📱|⚙|↺/);

    await shotBothViewports(page, "projects-after-populated");
  });

  test("empty state shows the v-empty card with the run-Claude-Code hint", async ({ page }) => {
    await mountProjects(page, []);
    await expect(page.locator(".v-empty")).toBeVisible();
    await expect(page.locator(".v-empty-icon.ph-folder-open")).toBeAttached();
    await expect(page.locator(".v-empty-title")).toHaveText("No projects yet");
    await expect(page.locator(".v-empty-hint")).toContainText("Claude Code");
    await expect(page.locator(".project-card")).toHaveCount(0);

    await shotBothViewports(page, "projects-after-empty");
  });

  test("error state is distinct from empty and Retry recovers", async ({ page }) => {
    // list_project_groups deliberately unmocked - rejects, driving the error state.
    await mountProjects(page, undefined);
    await expect(page.locator(".v-empty")).toBeVisible();
    await expect(page.locator(".v-empty-icon.ph-warning")).toBeAttached();
    await expect(page.locator(".v-empty-title")).toHaveText("Couldn't load projects");
    const retryBtn = page.locator(".v-empty button.btn-secondary");
    await expect(retryBtn).toHaveText(/Retry/);

    // Patch the mock so the retried call succeeds, same technique the AUQ
    // failure specs use to flip a command's outcome mid-test.
    await page.evaluate((groups) => {
      const w = window as unknown as {
        __TAURI__: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
      };
      const real = w.__TAURI__.core.invoke;
      w.__TAURI__.core.invoke = (cmd, args) => {
        if (cmd === "list_project_groups") return Promise.resolve(groups);
        return real(cmd, args);
      };
    }, POPULATED);

    await retryBtn.click();
    await expect(page.locator(".project-card")).toHaveCount(7);
    await expect(page.locator(".v-empty")).toHaveCount(0);
  });

  test("keyboard path: Tab to the first card and Enter navigates to project detail", async ({ page }) => {
    await mountProjects(page, POPULATED);
    await page.locator(".project-card").first().waitFor();
    await installNavSpy(page);

    const firstCard = page.locator(".project-card").first();
    for (let i = 0; i < 15; i++) {
      const onCard = await page.evaluate(() => document.activeElement?.classList.contains("project-card") ?? false);
      if (onCard) break;
      await page.keyboard.press("Tab");
    }
    await expect(firstCard).toBeFocused();

    await page.keyboard.press("Enter");
    expect(await navCalls(page)).toEqual(["project-detail"]);
  });

  test("search filters by name and parent segment; Escape clears it", async ({ page }) => {
    await mountProjects(page, POPULATED);
    await page.locator(".project-card").first().waitFor();
    await expect(page.locator(".projects-count")).toHaveCount(0);

    const search = page.locator("#projectsSearchInput");
    await search.fill("beta");
    await expect(page.locator(".project-card")).toHaveCount(1);
    await expect(page.locator(".project-card")).toContainText("Beta");
    await expect(page.locator(".projects-count")).toHaveText("1 of 7");

    // Matches by parent_segment too, not just name.
    await search.fill("monorepo");
    await expect(page.locator(".project-card")).toHaveCount(1);
    await expect(page.locator(".project-card")).toContainText("api");

    // No matches: the distinct "no matches" empty variant, not the generic one.
    await search.fill("zzz-nope");
    await expect(page.locator(".v-empty-title")).toHaveText('No matches for "zzz-nope"');

    await search.focus();
    await page.keyboard.press("Escape");
    await expect(search).toHaveValue("");
    await expect(page.locator(".project-card")).toHaveCount(7);
    await expect(page.locator(".projects-count")).toHaveCount(0);
  });
});
