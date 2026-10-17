// asserts: src/views/sessions/worktree-picker.css
import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";

// Phone: dock the worktree/location sub-picker to the bottom, same as the
// project picker right before it in the chain (project-picker-phone-sheet.
// view.spec.ts) and the model/effort modal right after it
// (model-effort-modal-phone-sheet.view.spec.ts). `.wt-picker-modal` backs
// BOTH the worktree choice screen (exercised here, same setup as
// popup-chain-morph.view.spec.ts) and location-picker.ts's "Open <project>"
// card - one rule covers both.

const PHONE = { width: 393, height: 852 };

const PROJECT = {
  id: "proj1", path: "C:/repo", name: "repo", parent_segment: null,
  avatar: { kind: "none" }, automation_enabled: false, tokens_7d: 0, live: 0,
  any_remote: false, any_automated: false, last_active_at: null, path_exists: true,
  worktrees: [{ path: "C:/repo/wt-a", name: "wt-a", tokens_7d: 0, live: 0, last_active_at: null, path_exists: true }],
  last_worktree_path: null, last_start_folder_rel: null,
};

const BASE_INVOKE = {
  get_accounts_setup_prompt_state: { shouldShow: false },
  list_project_groups: [PROJECT],
  project_last_activity_at: 0,
  count_ai_todos: 0,
  list_claude_md_scopes: [{ rel_path: "", label: "Repo root", nested: false }],
  list_worktree_details: [
    { path: "C:/repo/wt-a", name: "wt-a", branch: "feature-a", last_commit_at: null, stale: false, stale_reason: null },
  ],
};

async function openWorktreePicker(page: Page): Promise<void> {
  await mountView(page, { invoke: BASE_INVOKE });
  await page.evaluate(() => {
    void (window as unknown as { __startNewSession: () => Promise<void> }).__startNewSession();
  });
  await page.locator(".project-picker-row").click();
  await page.locator(".loc-chip").click(); // "Change worktree" chip -> worktree-picker choice screen
  await page.waitForSelector(".wt-picker-modal");
  // Two chained morphs (project -> location -> worktree, modal.ts's
  // shrink/swap/expand) land this card via an animated transform. It's
  // rendered WITH .modal-card-morph-hidden already on it (fully translated
  // off-screen, per project-picker.css's twin rule), removed one frame
  // later to kick off the entrance transition - polling for rect stability
  // from the very first frame can lock onto that static hidden frame before
  // the transition even starts (observed: y+height far past the viewport
  // edge). Wait for the class to actually be gone first, then poll until the
  // ensuing transition itself settles.
  await page.waitForFunction(() =>
    !document.querySelector(".wt-picker-modal")?.classList.contains("modal-card-morph-hidden"));
  await page.evaluate(() => new Promise<void>((resolve) => {
    const el = document.querySelector(".wt-picker-modal") as HTMLElement;
    let last = JSON.stringify(el.getBoundingClientRect());
    let stableFrames = 0;
    function check() {
      const cur = JSON.stringify(el.getBoundingClientRect());
      if (cur === last) {
        stableFrames++;
        if (stableFrames >= 3) return resolve();
      } else {
        stableFrames = 0;
      }
      last = cur;
      requestAnimationFrame(check);
    }
    requestAnimationFrame(check);
  }));
}

test.describe("view-harness / worktree picker phone bottom sheet", () => {
  test("phone: card docks flush to the bottom edge, full width, rounded top corners only", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openWorktreePicker(page);

    const card = page.locator(".wt-picker-modal");
    const box = (await card.boundingBox())!;

    expect(box.x).toBe(0);
    expect(box.width).toBe(PHONE.width);
    expect(Math.round(box.y + box.height)).toBe(PHONE.height);

    const radius = await card.evaluate((el) => getComputedStyle(el).borderRadius);
    // Centred desktop box is a uniform 8px radius (base rule) - the phone
    // sheet must be rounded on top only, square on the bottom.
    expect(radius).not.toBe("8px");
  });

  test("desktop: card stays centred, unchanged", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openWorktreePicker(page);

    const card = page.locator(".wt-picker-modal");
    const box = (await card.boundingBox())!;

    expect(box.y).toBeGreaterThan(40);
    expect(box.y + box.height).toBeLessThan(800 - 40);
    expect(box.x).toBeGreaterThan(40);
    expect(box.x + box.width).toBeLessThan(1280 - 40);

    const radius = await card.evaluate((el) => getComputedStyle(el).borderRadius);
    expect(radius).toBe("8px");
  });
});
