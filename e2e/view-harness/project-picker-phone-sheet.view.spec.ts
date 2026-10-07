import { test, expect, type Page } from "@playwright/test";
import { mountView, capture } from "./harness";

// Phone: dock the project picker to the bottom instead of centring it
// (todo 1077). Before this change project-picker.css had no phone breakpoint
// at all, so the "Pick project" card stayed centred via
// `top:50%;left:50%;transform:translate(-50%,-50%)` on every viewport,
// floating mid-screen with Cancel well above the thumb zone on a real phone.
// Pattern matches the AUQ/question-card bottom sheet (permission-modal-shell.css,
// auq-mobile-sheet.view.spec.ts): flush to the side edges, docked to the
// bottom, rounded top corners only, safe-area-aware bottom padding.

const PHONE = { width: 393, height: 852 };

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
  proj("proj-a", "countoff", "C:/Projects/countoff"),
  proj("proj-b", "zng-app", "C:/Projects/zng-app"),
];

const BASE_INVOKE = {
  get_accounts_setup_prompt_state: { shouldShow: false },
  list_project_groups: PROJECTS,
  project_last_activity_at: 0,
  count_ai_todos: 0,
  list_claude_md_scopes: [{ rel_path: "", label: "Repo root", nested: false }],
  list_worktree_details: [],
};

async function openPicker(page: Page): Promise<void> {
  await mountView(page, { invoke: BASE_INVOKE });
  await page.evaluate(() => {
    void (window as unknown as { __startNewSession: () => Promise<void> }).__startNewSession();
  });
  await page.waitForSelector(".project-picker-row");
}

async function overrideSafeArea(page: Page, bottom: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", {
    insets: { bottom, bottomMax: bottom },
  } as never);
}

test.describe("view-harness / project picker phone bottom sheet", () => {
  test("phone: card docks flush to the bottom edge, full width, rounded top corners only", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openPicker(page);

    const card = page.locator(".project-picker-modal");
    const box = (await card.boundingBox())!;

    // Flush to both side edges.
    expect(box.x).toBe(0);
    expect(box.width).toBe(PHONE.width);
    // Docked to the bottom edge (no safe-area inset here, so flush to 0).
    expect(Math.round(box.y + box.height)).toBe(PHONE.height);

    const radius = await card.evaluate((el) => getComputedStyle(el).borderRadius);
    // Centred desktop box is a uniform 8px radius (base rule) - the phone
    // sheet must be rounded on top only, square on the bottom.
    expect(radius).not.toBe("8px");

    await capture(page, "project-picker-phone-sheet");
  });

  // The footer's own padding-box is flush with the viewport bottom by design
  // (padding fills the inset) - the Cancel button inside it must clear, not
  // the box, matching the AUQ sheet's footer clearance pattern.
  test("phone: footer's Cancel button clears a real safe-area inset", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await overrideSafeArea(page, 100);
    await openPicker(page);

    const cancelBtn = page.locator(".project-picker-modal .modal-footer button", { hasText: "Cancel" });
    const btnBox = (await cancelBtn.boundingBox())!;
    expect(PHONE.height - (btnBox.y + btnBox.height)).toBeGreaterThanOrEqual(100);
  });

  test("desktop: card stays centred, unchanged", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openPicker(page);

    const card = page.locator(".project-picker-modal");
    const box = (await card.boundingBox())!;

    // Centred both axes, with a real gap on every side - not docked anywhere.
    expect(box.y).toBeGreaterThan(40);
    expect(box.y + box.height).toBeLessThan(800 - 40);
    expect(box.x).toBeGreaterThan(40);
    expect(box.x + box.width).toBeLessThan(1280 - 40);

    const radius = await card.evaluate((el) => getComputedStyle(el).borderRadius);
    expect(radius).toBe("8px");
  });

  test("phone: sheet height tracks a shrunk (keyboard-resized) viewport, search field stays reachable", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openPicker(page);

    const searchBefore = (await page.locator("#project-picker-search").boundingBox())!;
    expect(searchBefore.y).toBeGreaterThanOrEqual(0);
    expect(searchBefore.y + searchBefore.height).toBeLessThanOrEqual(PHONE.height);

    // interactive-widget=resizes-content (index.html) means the soft keyboard
    // actually shrinks the visual viewport, which is what a real device would
    // do - emulate that directly rather than fake it some other way.
    await page.setViewportSize({ width: PHONE.width, height: 420 });

    const card = page.locator(".project-picker-modal");
    const box = (await card.boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(420);

    const searchAfter = (await page.locator("#project-picker-search").boundingBox())!;
    expect(searchAfter.y).toBeGreaterThanOrEqual(0);
    expect(searchAfter.y + searchAfter.height).toBeLessThanOrEqual(420);
  });
});
