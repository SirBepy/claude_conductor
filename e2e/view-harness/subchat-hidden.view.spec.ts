// Reviewed 2026-11-05: a main chat waiting for its subs to close stays in Main chats with an hourglass, the sub list orders Finished by finish time, a sub header wears its list initials and the all-finished card names unmerged subs; this spec asserts none of those and it passes.
// Reviewed 2026-11-05: sidebar-entries.ts and view-more-menu.ts: a chat with subs keeps its sub summary after the mode is turned off, and a sub's own menu drops "Use subchats"; subs still have no row and this spec passes.
// Reviewed 2026-11-05: quiet daemon cards (a checkup yields, no dot), the mode-set nudge, the draft header dressing, the statusbar model sync and the sub-aware /close chip touch permission-modal and the sessions chrome; this spec's contract is unchanged and it passes.
import { test, expect } from "@playwright/test";
import { mountSessionsList, sessionInstance } from "./harness";

// A hidden sub (Use subchats) owns no sidebar row, no Ctrl+N number and no
// project-rail chip, on desktop or at phone width. Its row stays in the
// instance list on purpose (remote lists keep it so a parked prompt is not
// orphaned), so the hiding is the client's job and this drives the real list
// build, not the helper alone.
//
// asserts: src/views/sessions/sidebar-entries.ts, src/views/sessions/sessions-helpers.ts, src/views/sessions/view-more-menu.ts, src/views/sessions/sidebar.ts

const PHONE = { width: 390, height: 780 };

const rows = () => [
  sessionInstance({ session_id: "main", name: "Main chat", cwd: "C:/Projects/alpha" }),
  sessionInstance({ session_id: "other", name: "Other chat", cwd: "C:/Projects/beta" }),
  sessionInstance({
    session_id: "sub-1", name: "Hidden sub", cwd: "C:/Projects/gamma", subchat_of: "main", busy: true,
  }),
];

async function expectSubHidden(page: import("@playwright/test").Page): Promise<void> {
  const list = page.locator("#sessions-list");
  await expect(list.locator('li[data-session-id="main"]')).toHaveCount(1);
  await expect(list.locator('li[data-session-id="other"]')).toHaveCount(1);
  await expect(list.locator('li[data-session-id="sub-1"]')).toHaveCount(0);
  await expect(list).not.toContainText("Hidden sub");
}

test("a sub has no sidebar row on desktop and takes no Ctrl+N number", async ({ page }) => {
  await mountSessionsList(page, rows());
  await expectSubHidden(page);
  const list = page.locator("#sessions-list");
  await page.keyboard.down("Control");
  await expect(list).toHaveClass(/kbd-hint-active/);
  const hints = await list.locator("li[data-kbd-hint]").evaluateAll(
    (els) => els.map((e) => e.getAttribute("data-kbd-hint")),
  );
  expect(hints.sort()).toEqual(["1", "2"]);
  await page.keyboard.up("Control");
});

test("a sub has no row at phone width either", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await mountSessionsList(page, rows());
  await expectSubHidden(page);
});

test("a sub's project gets no rail chip", async ({ page }) => {
  await mountSessionsList(page, rows());
  const avatars = page.locator("#project-rail .project-rail-avatar");
  await expect(avatars).toHaveCount(2);
  await expect(page.locator('#project-rail .project-rail-avatar[data-cwd="C:/Projects/gamma"]')).toHaveCount(0);
});
