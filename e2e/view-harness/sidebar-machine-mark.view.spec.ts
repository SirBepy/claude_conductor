import { test, expect } from "@playwright/test";
import { SESSIONS_BASE_INVOKE, sessionInstance, mountView, mountViewPhone, capture } from "./harness";

// Multi-machine federation: the sidebar mark for a session mirrored in from a
// paired peer machine - that machine's icon after the project name (online),
// an --offline variant plus a dimmed row (offline), and on desktop nothing at
// all for a locally-hosted row. The phone marks every row, its own daemon's
// included, and never as text.

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

// m1 and m2 are both Macs: the lower id keeps the Apple logo, m2 gets its own.
const peer = (machine_id: string, label: string, os: string) => ({
  machine_id, label, os, iroh_id: null, direct_url: null, reverse_device_id: null, added_at: 0, reach: "iroh",
});
const MACHINES = {
  self: { machine_id: "self", label: "Main_Desktop", os: "windows" },
  peers: [peer("m1", "Mac Mini", "macos"), peer("m2", "Mac Mini", "macos")],
};

async function mountSessions(page: import("@playwright/test").Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: { ...SESSIONS_BASE_INVOKE, list_instances: SESSIONS, get_active_sessions: SESSIONS, list_machines: MACHINES },
  });
  await page.locator("#sessions-list li[data-session-id]").first().waitFor();
}

async function mountSessionsPhone(page: import("@playwright/test").Page, sessions = SESSIONS): Promise<void> {
  await mountViewPhone(page, {
    view: "sessions",
    invoke: { ...SESSIONS_BASE_INVOKE, list_instances: sessions, get_active_sessions: sessions, list_machines: MACHINES },
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

  test("a mirrored online row shows its machine's logo with an 'On <label>' tip", async ({ page }) => {
    await mountSessions(page);
    const row = page.locator('#sessions-list li[data-session-id="s-online"]');
    const badge = row.locator(".session-row-project .session-machine-badge");
    await expect(badge).toHaveCount(1);
    await expect(badge).toHaveClass(/ph-apple-logo/);
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

  test("desktop: no row ever renders a text machine label", async ({ page }) => {
    await mountSessions(page);
    await expect(page.locator("#sessions-list .session-machine-label")).toHaveCount(0);
  });

  // Phone (isRemote() true): the phone is none of the machines, so its own
  // daemon's rows get that daemon's icon too, and a second Mac gets an icon
  // of its own instead of a name in text.
  test("phone: every row carries its machine's icon and no text label", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await mountSessionsPhone(page);

    const badge = (id: string) => page.locator(`#sessions-list li[data-session-id="${id}"] .session-machine-badge`);
    await expect(badge("s-local")).toHaveClass(/ph-windows-logo/);
    await expect(badge("s-local")).toHaveAttribute("data-tip", "On Main_Desktop");
    await expect(badge("s-online")).toHaveClass(/ph-apple-logo/);
    await expect(badge("s-offline")).not.toHaveClass(/ph-apple-logo|ph-windows-logo/);
    await expect(badge("s-offline")).toHaveClass(/session-machine-badge--offline/);
    await expect(page.locator("#sessions-list .session-machine-label")).toHaveCount(0);

    await capture(page, "sidebar-machine-mark-phone");
  });
});
