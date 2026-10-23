// asserts: src/views/sessions/project-picker.ts, src/views/sessions/machine-field.ts
//
// Search loosened to fuzzy (subsequence) matching on top of the existing
// exact/startsWith/includes tiers - a no-op here, this spec never searches.
import { test, expect, type Page } from "@playwright/test";
import { mountViewPhone, capture } from "./harness";

// G8 (docs/multi-machine.md): list_machines/list_machine_projects are now
// phone-reachable and project-picker.ts's old desktop-only gate on fetching
// them is lifted, so the phone's new-chat picker must grow the same machine
// chip row desktop already had (H4) - self + one chip per peer - and it must
// fit the 390px-wide phone sheet without spilling past the viewport edge.
// Updated 2026-10-23 for the {groups, stats} list_machine_projects shape: the
// peer chip's rows now carry the peer's todo badge (asserted in test 2).
// The machineId-selection flow itself (picking the peer chip, then one of its
// projects, resolves with that peer's id) is pinned in
// tests/project-picker-machine-flow.test.mjs - project-picker.ts exposes no
// DOM hook for an e2e spec to read the resolved value mid-chain.
//
// Reviewed against project-picker.ts's new cold-load skeleton + row entrance
// animation - re-ran this file after that change, all tests still pass.
//
// Reviewed 2026-10-20 (Mac-mirrored project icon fix): project-picker.ts's
// row render now passes machineField.machineId as renderAvatar's 3rd arg,
// stamping a data-proj-face-machine attribute so the icon fetch asks the
// right peer's filesystem. This spec's second test DOES select the peer chip
// and render its project row, but only asserts row text (.toHaveText), never
// the avatar markup or icon fetch - unaffected. The capture() screenshot runs
// with self selected (the default), where machineId stays null - unaffected.

const PHONE = { width: 390, height: 800 };

function proj(id: string, name: string, path: string) {
  return {
    id, path, name, parent_segment: null,
    avatar: { kind: "none" }, automation_enabled: false, tokens_7d: 0, live: 0,
    any_automated: false, last_active_at: null,
    path_exists: true, worktrees: [],
    last_worktree_path: null, last_start_folder_rel: null,
  };
}

const LOCAL_PROJECTS = [proj("proj-a", "countoff", "C:/Projects/countoff")];
// list_machine_projects now answers {groups, stats} (the picker's own two
// pieces), not a bare ProjectConfig[].
const PEER_PROJECTS = {
  groups: [proj("peer-proj-1", "widget", "C:/PeerProjects/widget")],
  stats: { "C:/PeerProjects/widget": { mtime: 0, todoCount: 2 } },
};

const SELF_LABEL = "Joe-PC";
const PEER_LABEL = "Mac Mini";

const BASE_INVOKE = {
  get_accounts_setup_prompt_state: { shouldShow: false },
  list_project_groups: LOCAL_PROJECTS,
  project_last_activity_at: 0,
  count_ai_todos: 0,
  list_claude_md_scopes: [{ rel_path: "", label: "Repo root", nested: false }],
  list_worktree_details: [],
  list_machines: {
    self: { machine_id: "self", label: SELF_LABEL, os: "windows" },
    peers: [{
      machine_id: "peer-1", label: PEER_LABEL, os: "macos",
      iroh_id: null, direct_url: null, reverse_device_id: null, added_at: 0,
      reach: "direct",
    }],
  },
  list_machine_projects: PEER_PROJECTS,
};

async function openPickerOnPhone(page: Page): Promise<void> {
  await mountViewPhone(page, { invoke: BASE_INVOKE });
  await page.waitForFunction(() => typeof (window as unknown as { __startNewSession?: () => Promise<void> }).__startNewSession === "function");
  await page.evaluate(() => {
    void (window as unknown as { __startNewSession: () => Promise<void> }).__startNewSession();
  });
  await page.waitForSelector(".project-picker-row");
}

test.describe("view-harness / phone project picker machine chips (G8)", () => {
  test("phone: self + peer chips render with real labels, no horizontal overflow at 390px", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openPickerOnPhone(page);

    const chips = page.locator(".machine-field-chips .machine-chip");
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toHaveText(SELF_LABEL);
    await expect(chips.nth(1)).toHaveText(PEER_LABEL);
    // The self chip is the default selection, same as desktop.
    await expect(chips.nth(0)).toHaveClass(/sel/);

    const rowBox = (await page.locator(".machine-field-chips").boundingBox())!;
    expect(rowBox.x).toBeGreaterThanOrEqual(0);
    expect(Math.round(rowBox.x + rowBox.width)).toBeLessThanOrEqual(PHONE.width);
    // No scrollbar forced by the chip row - flex-wrap, not horizontal overflow.
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(PHONE.width);

    await capture(page, "project-picker-phone-machine-chips");
  });

  test("phone: picking the peer chip swaps the list to its projects", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openPickerOnPhone(page);

    await expect(page.locator(".project-picker-row")).toHaveText(/countoff/);

    await page.locator(".machine-field-chips .machine-chip", { hasText: PEER_LABEL }).click();

    await expect(page.locator(".machine-field-chips .machine-chip", { hasText: PEER_LABEL })).toHaveClass(/sel/);
    await expect(page.locator(".project-picker-row")).toHaveText(/widget/);
    // The peer's own stats ride along with its list.
    await expect(page.locator(".project-picker-row .project-picker-todo-badge")).toHaveText("2");
  });

  test("older daemon (list_machines unmocked/failing): picker still opens, no chip row, no crash", async ({ page }) => {
    await page.setViewportSize(PHONE);
    const invoke = { ...BASE_INVOKE };
    delete (invoke as Record<string, unknown>).list_machines;
    await mountViewPhone(page, { invoke });
    await page.waitForFunction(() => typeof (window as unknown as { __startNewSession?: () => Promise<void> }).__startNewSession === "function");
    await page.evaluate(() => {
      void (window as unknown as { __startNewSession: () => Promise<void> }).__startNewSession();
    });
    await page.waitForSelector(".project-picker-row");

    await expect(page.locator(".machine-field")).toHaveCount(0);
  });
});
