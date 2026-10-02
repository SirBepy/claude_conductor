import { test, expect, type Page } from "@playwright/test";
import { mountView, invokeCalls } from "./harness";

// Adding a project, inline in the empty-results state (Joe's variant C,
// 2026-09-26). Replaces the footer's "New project…" / "Open in new folder…"
// pair: both said "folder", one said "new" while the other meant "existing",
// so neither label distinguished them. Typing a name that matches nothing now
// offers both routes with the name already filled in.
//
// The projects root shown in the Create row uses wording L2 - the path itself
// is the control, so there is no label to word ambiguously.
//
// asserts: src/views/sessions/project-picker.ts, src/views/sessions/project-picker/add-project.ts, src/views/sessions/projects-root.ts

const ROOT = "C:\\Users\\tecno\\Desktop\\Projects";

function proj(id: string, name: string, path: string) {
  return {
    id, path, name, parent_segment: null,
    avatar: { kind: "none" }, automation_enabled: false, tokens_7d: 0, live: 0,
    any_remote: false, any_automated: false, last_active_at: null,
    path_exists: true, worktrees: [],
    last_worktree_path: null, last_start_folder_rel: null,
  };
}

function baseInvoke(overrides: Record<string, unknown> = {}) {
  return {
    get_accounts_setup_prompt_state: { shouldShow: false },
    // Two projects under one parent, which is the minimum the inference
    // treats as a real signal rather than a coincidence.
    list_project_groups: [
      proj("p-zng", "zng-app", `${ROOT}\\zng-app`),
      proj("p-cnt", "countoff", `${ROOT}\\countoff`),
    ],
    project_last_activity_at: 0,
    count_ai_todos: 0,
    list_claude_md_scopes: [{ rel_path: "", label: "Repo root", nested: false }],
    list_worktree_details: [],
    get_settings: {},
    ...overrides,
  };
}

async function openPicker(page: Page, overrides: Record<string, unknown> = {}): Promise<void> {
  await mountView(page, { invoke: baseInvoke(overrides) });
  await page.evaluate((k) => localStorage.removeItem(k), "claude_companion_project_favorites");
  await page.evaluate(() => {
    void (window as unknown as { __startNewSession: () => Promise<void> }).__startNewSession();
  });
  await page.waitForSelector(".project-picker-row");
}

test.describe("view-harness / add a project inline", () => {
  test("a search that matches nothing offers Create and Browse, not a dead 'No matches'", async ({ page }) => {
    await openPicker(page);

    await page.locator("#project-picker-search").fill("side-quest");

    await expect(page.locator(".pp-inline-actions")).toHaveCount(1);
    await expect(page.locator(".pp-act").first()).toContainText('Create "side-quest"');
    await expect(page.locator(".pp-act").nth(1)).toContainText("Browse for a folder");
    await expect(page.locator(".project-picker-empty")).toHaveCount(0);
  });

  test("the Create row shows the inferred projects root, with no setting configured", async ({ page }) => {
    await openPicker(page);
    await page.locator("#project-picker-search").fill("side-quest");

    // get_settings returned {} - this path is derived from where the existing
    // projects already live, so it is right before anything is configured.
    await expect(page.locator(".pp-root-inline")).toContainText(ROOT);
  });

  test("an explicitly stored root beats the inference", async ({ page }) => {
    await openPicker(page, { get_settings: { newProjectLastParent: "D:\\elsewhere" } });
    await page.locator("#project-picker-search").fill("side-quest");

    await expect(page.locator(".pp-root-inline")).toContainText("D:\\elsewhere");
    await expect(page.locator(".pp-root-inline")).not.toContainText(ROOT);
  });

  test("Create makes the folder under the root and resolves the picker", async ({ page }) => {
    await openPicker(page, { create_folder: null });
    await page.locator("#project-picker-search").fill("side-quest");

    await page.locator(".pp-act", { hasText: "Create" }).click();

    await expect(page.locator(".project-picker-modal")).toHaveCount(0);
    const calls = await invokeCalls(page);
    const created = calls.find((c) => c.cmd === "create_folder");
    expect(created).toBeTruthy();
    expect((created!.args as { path: string }).path).toBe(`${ROOT}\\side-quest`);
  });

  test("clicking the path opens the folder picker WITHOUT firing Create", async ({ page }) => {
    await openPicker(page, { pick_folder: null });
    await page.locator("#project-picker-search").fill("side-quest");

    await page.locator(".pp-root-inline").click();

    // The nested control must not bubble into the row that contains it - the
    // whole reason that row is a role="button" div rather than a <button>.
    await expect(page.locator(".project-picker-modal")).toHaveCount(1);
    const calls = await invokeCalls(page);
    expect(calls.some((c) => c.cmd === "pick_folder")).toBe(true);
    expect(calls.some((c) => c.cmd === "create_folder")).toBe(false);
  });

  test("a typed term that is a path, not a name, offers Browse only", async ({ page }) => {
    await openPicker(page);

    await page.locator("#project-picker-search").fill("../evil");

    await expect(page.locator(".pp-act", { hasText: "Create" })).toHaveCount(0);
    await expect(page.locator(".pp-act", { hasText: "Browse" })).toHaveCount(1);
    await expect(page.locator(".pp-inline-hint")).toBeVisible();
  });

  test("clearing the search puts the normal list back", async ({ page }) => {
    await openPicker(page);
    const search = page.locator("#project-picker-search");

    await search.fill("side-quest");
    await expect(page.locator(".pp-inline-actions")).toHaveCount(1);

    await search.fill("");

    await expect(page.locator(".pp-inline-actions")).toHaveCount(0);
    await expect(page.locator(".project-picker-row")).toHaveCount(2);
  });

  test("with zero projects on a cold cache the picker stays open and offers Create and Browse", async ({ page }) => {
    await mountView(page, { invoke: baseInvoke({ list_project_groups: [], create_folder: null, pick_folder: null }) });
    // Boot warms the project cache, which would make this the warm path; the
    // delay (installed ahead of a reload, same trick as
    // new-session-cold-cache.view.spec.ts) keeps it cold when the picker opens.
    await page.addInitScript(() => {
      const w = window as unknown as {
        __TAURI__?: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
      };
      const tauri = w.__TAURI__;
      if (!tauri) return;
      const orig = tauri.core.invoke;
      tauri.core.invoke = (cmd: string, args?: Record<string, unknown>) =>
        cmd === "list_project_groups"
          ? new Promise((resolve) => setTimeout(() => resolve(orig(cmd, args)), 1000))
          : orig(cmd, args);
    });
    await page.reload();
    await page.waitForFunction(() => typeof (window as unknown as { __startNewSession?: unknown }).__startNewSession === "function");
    await page.evaluate(() => {
      void (window as unknown as { __startNewSession: () => Promise<void> }).__startNewSession();
    });
    await expect(page.locator(".modal-card-loading")).toBeVisible();

    await expect(page.locator(".project-picker-modal")).toHaveCount(1);
    await expect(page.locator(".pp-inline-hint")).toContainText("No projects yet");
    await expect(page.locator(".pp-act", { hasText: "Browse" })).toHaveCount(1);

    await page.locator("#project-picker-search").fill("first-one");
    await expect(page.locator(".pp-act", { hasText: 'Create "first-one"' })).toHaveCount(1);
  });

  // NOT covered here: the remote/peer-machine branch, where Create is hidden
  // because a peer's filesystem is not ours to create folders on. Exercising
  // it needs a list_machines fixture with a live peer plus a chip click, which
  // machine-field.ts owns; asserting it from this spec without actually
  // selecting a machine would only prove the local case twice.
});
