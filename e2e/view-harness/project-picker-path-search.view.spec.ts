import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// The search box matches a project's NAME fuzzily ("mcp" finds
// mc_plugins_tag) but its PATH only as a substring: a full absolute path is
// long enough that almost any short query's letters appear in it in order,
// so a fuzzy path match surfaced unrelated projects ("cat" found
// claude_usage_in_taskbar through c-laude, a-ge, t-ecno).

function proj(id: string, name: string, path: string) {
  return {
    id, path, name, parent_segment: null,
    avatar: { kind: "none" }, automation_enabled: false, tokens_7d: 0, live: 0,
    any_remote: false, any_automated: false, last_active_at: null,
    path_exists: true, worktrees: [],
    last_worktree_path: null, last_start_folder_rel: null,
  };
}

const PROJECTS = [
  proj("p-taskbar", "taskbar-widgets", "C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar"),
  proj("p-cats", "cats-app", "C:/Work/cats-app"),
];

async function openPicker(page: import("@playwright/test").Page): Promise<void> {
  await mountView(page, {
    invoke: {
      get_accounts_setup_prompt_state: { shouldShow: false },
      list_project_groups: PROJECTS,
      project_last_activity_at: 0,
      count_ai_todos: 0,
      list_claude_md_scopes: [{ rel_path: "", label: "Repo root", nested: false }],
      list_worktree_details: [],
    },
  });
  // Fire-and-forget: the promise only resolves once the whole chain finishes.
  await page.evaluate(() => {
    void (window as unknown as { __startNewSession: () => Promise<void> }).__startNewSession();
  });
  await page.waitForSelector(".project-picker-row");
}

test.describe("view-harness / project picker path search", () => {
  test("a short query does not match a project only through scattered letters of its path", async ({ page }) => {
    await openPicker(page);
    await page.locator("#project-picker-search").fill("cat");
    await expect(page.locator(".project-picker-name")).toHaveText(["cats-app"]);
  });

  test("a query that is part of the path still finds the project", async ({ page }) => {
    await openPicker(page);
    await page.locator("#project-picker-search").fill("desktop/projects");
    await expect(page.locator(".project-picker-name")).toHaveText(["taskbar-widgets"]);
  });
});
