import { test, expect } from "@playwright/test";
import { SESSIONS_BASE_INVOKE, sessionInstance, mountView, mountViewPhone, capture } from "./harness";

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

const LONG_LABEL = "Joes-MacBook-Pro-16-Max-2026";
const MIRRORED_LONG_LABEL = instance({
  session_id: "s-long",
  cwd: "C:/Projects/long-label-app",
  machine: { id: "m3", label: LONG_LABEL, online: true },
});

async function mountSessionsPhone(page: import("@playwright/test").Page, sessions = SESSIONS): Promise<void> {
  await mountViewPhone(page, {
    view: "sessions",
    invoke: { ...SESSIONS_BASE_INVOKE, list_instances: sessions, get_active_sessions: sessions },
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

    // `.row-entering` runs slideInLeft, which animates opacity 0->1. An
    // animated value outranks the static `opacity: .55` on
    // `.is-machine-offline`, so sampling inside that 0.32s window reads the
    // same mid-flight number off both rows and the comparison is meaningless.
    // sidebar-anim.ts drops the class on animationend.
    const localRow = page.locator('#sessions-list li[data-session-id="s-local"]');
    await expect(localRow).not.toHaveClass(/row-entering/);
    await expect(row).not.toHaveClass(/row-entering/);

    const [localOpacity, offlineOpacity] = await Promise.all([
      localRow.evaluate((el) => getComputedStyle(el).opacity),
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

  // Phone (isRemote() true): the machine label renders as visible muted text,
  // additional to the glyph+tooltip desktop already shows (G9, docs/multi-machine.md).
  test("desktop: no row ever gets the visible machine-label span", async ({ page }) => {
    await mountSessions(page);
    await expect(page.locator("#sessions-list .session-machine-label")).toHaveCount(0);
  });

  test("phone: a mirrored row shows the machine label as text; a local row doesn't", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await mountSessionsPhone(page);

    const localLabel = page.locator('#sessions-list li[data-session-id="s-local"] .session-machine-label');
    await expect(localLabel).toHaveCount(0);

    const onlineLabel = page.locator('#sessions-list li[data-session-id="s-online"] .session-machine-label');
    await expect(onlineLabel).toHaveCount(1);
    await expect(onlineLabel).toHaveText("Mac Mini");
    await expect(onlineLabel).not.toHaveClass(/session-machine-label--offline/);

    const offlineLabel = page.locator('#sessions-list li[data-session-id="s-offline"] .session-machine-label');
    await expect(offlineLabel).toHaveClass(/session-machine-label--offline/);

    await capture(page, "sidebar-machine-mark-phone");
  });

  test("phone at 390px: a long machine label stays single-line and bounded", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await mountSessionsPhone(page, [LOCAL, MIRRORED_LONG_LABEL]);

    const row = page.locator('#sessions-list li[data-session-id="s-long"]');
    const label = row.locator(".session-machine-label");
    await expect(label).toHaveText(LONG_LABEL);

    // The entrance animation translateX()-slides a freshly-mounted row; a box
    // read mid-slide reports whatever offset the row sits at that frame, not
    // its settled position (same wait the offline-dim test above needs).
    const localRow = page.locator('#sessions-list li[data-session-id="s-local"]');
    await expect(localRow).not.toHaveClass(/row-entering/);
    await expect(row).not.toHaveClass(/row-entering/);

    const localLine = page.locator('#sessions-list li[data-session-id="s-local"] .session-row-project');
    const longLine = row.locator(".session-row-project");
    const [localBox, longBox, labelBox] = await Promise.all([
      localLine.boundingBox(),
      longLine.boundingBox(),
      label.boundingBox(),
    ]);
    expect(labelBox).not.toBeNull();
    // Single-line (no wrap): same row height as the plain local row.
    expect(Math.round(longBox!.height)).toBe(Math.round(localBox!.height));
    expect(labelBox!.width).toBeLessThanOrEqual(72);

    await capture(page, "sidebar-machine-mark-phone-long-label");
  });
});
