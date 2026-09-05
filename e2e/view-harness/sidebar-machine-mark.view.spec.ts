import { test, expect } from "@playwright/test";
import { SESSIONS_BASE_INVOKE, sessionInstance, mountView, capture } from "./harness";

// Multi-machine federation (H2): the sidebar mark for a session mirrored in
// from a paired peer machine - a small glyph beside the project name (online),
// an --offline variant plus a dimmed row (offline), and nothing at all for a
// locally-hosted row.

function instance(over: Parameters<typeof sessionInstance>[0] = {}) {
  return sessionInstance({ cwd: "C:/Projects/claude_usage_in_taskbar", name: "Federation test row", ...over });
}

const LOCAL = instance({ session_id: "s-local", machine: null });
const MIRRORED_ONLINE = instance({
  session_id: "s-online",
  cwd: "C:/Projects/zng-app",
  machine: { id: "m1", label: "Mac Mini", online: true },
});
const MIRRORED_OFFLINE = instance({
  session_id: "s-offline",
  cwd: "C:/Projects/other-app",
  machine: { id: "m2", label: "Mac Mini", online: false },
});

const SESSIONS = [LOCAL, MIRRORED_ONLINE, MIRRORED_OFFLINE];

async function mountSessions(page: import("@playwright/test").Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: { ...SESSIONS_BASE_INVOKE, list_instances: SESSIONS, get_active_sessions: SESSIONS },
  });
  await page.locator("#sessions-list li[data-session-id]").first().waitFor();
}

test.describe("view-harness / sidebar machine mark", () => {
  test("a local row has no machine badge or offline class", async ({ page }) => {
    await mountSessions(page);
    const row = page.locator('#sessions-list li[data-session-id="s-local"]');
    await expect(row.locator(".session-machine-badge")).toHaveCount(0);
    await expect(row).not.toHaveClass(/is-machine-offline/);
  });

  test("a mirrored online row shows the glyph with an 'On <label>' tip", async ({ page }) => {
    await mountSessions(page);
    const row = page.locator('#sessions-list li[data-session-id="s-online"]');
    const badge = row.locator(".session-machine-badge");
    await expect(badge).toHaveCount(1);
    await expect(badge).not.toHaveClass(/session-machine-badge--offline/);
    await expect(badge).toHaveAttribute("data-tip", "On Mac Mini");
    await expect(row).not.toHaveClass(/is-machine-offline/);
  });

  test("a mirrored offline row gets the --offline glyph, is-machine-offline, and dims", async ({ page }) => {
    await mountSessions(page);
    const row = page.locator('#sessions-list li[data-session-id="s-offline"]');
    const badge = row.locator(".session-machine-badge");
    await expect(badge).toHaveClass(/session-machine-badge--offline/);
    await expect(badge).toHaveAttribute("data-tip", "On Mac Mini (offline)");
    await expect(row).toHaveClass(/is-machine-offline/);

    const [localOpacity, offlineOpacity] = await Promise.all([
      page.locator('#sessions-list li[data-session-id="s-local"]').evaluate((el) => getComputedStyle(el).opacity),
      row.evaluate((el) => getComputedStyle(el).opacity),
    ]);
    expect(Number(offlineOpacity)).toBeLessThan(Number(localOpacity));

    await capture(page, "sidebar-machine-mark-desktop");
  });

  test("at 390px wide, the offline row's project line stays single-line (no wrap)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await mountSessions(page);
    const localLine = page.locator('#sessions-list li[data-session-id="s-local"] .session-row-project');
    const offlineLine = page.locator('#sessions-list li[data-session-id="s-offline"] .session-row-project');
    const [localBox, offlineBox] = await Promise.all([localLine.boundingBox(), offlineLine.boundingBox()]);
    expect(localBox).not.toBeNull();
    expect(offlineBox).not.toBeNull();
    // Equal (single-line) height proves the extra glyph didn't force a wrap -
    // a wrapped line would be roughly double this row's line-height.
    expect(Math.round(offlineBox!.height)).toBe(Math.round(localBox!.height));

    await capture(page, "sidebar-machine-mark-390");
  });
});
