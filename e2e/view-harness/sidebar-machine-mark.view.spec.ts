// Reviewed 2026-11-21 (put away, pc-1806 step 5): a project's main chat that the daemon put away (hidden_at) joins the Hidden view with a Paused badge, opens read-only, and its Close reads Put away; nothing this spec asserts changed (its chats carry no hidden_at), and it passes in the run of every spec that depends on those files.
// Reviewed 2026-11-16 (chat heads, pc-1769): the machine glyph after the project name is the remote ring, the project-icon request and a hover-card line; the 390px test measures the head instead of a project line.
// asserts: src/views/sessions/chat-heads.ts, src/views/sessions/sidebar-ring.ts, src/views/sessions/sidebar-hover-card.ts
import { test, expect } from "@playwright/test";
import { SESSIONS_BASE_INVOKE, sessionInstance, mountView, mountViewPhone, capture } from "./harness";

// Multi-machine federation on the chat heads: a session mirrored in from a paired
// peer machine takes the neutral remote ring and asks for the peer's own project
// icon (online), dims (offline), and says "On <label>" in its hover card; a
// locally-hosted head has none of it. Never as text on the head. The old phone-only
// mark for this daemon's own rows has no head equivalent (a 44px head has no room
// for a machine glyph next to the project badge).

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
  const hoverCardOf = async (page: import("@playwright/test").Page, id: string) => {
    const head = page.locator(`#sessions-list li[data-session-id="${id}"]`);
    const box = (await head.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    return page.locator(".cc-row-card");
  };

  test("a local head has no peer-icon request and no offline class, and no head draws a ring", async ({ page }) => {
    await mountSessions(page);
    const row = page.locator('#sessions-list li[data-session-id="s-local"]');
    await expect(page.locator("#sessions-list .avatar-ring")).toHaveCount(0);
    expect(await row.innerHTML()).not.toContain("data-proj-face-machine");
    await expect(row).not.toHaveClass(/is-machine-offline/);
  });

  test("a mirrored online head asks for its machine's project icon and its card says 'On <label>'", async ({ page }) => {
    await mountSessions(page);
    const row = page.locator('#sessions-list li[data-session-id="s-online"]');
    expect(await row.innerHTML()).toContain('data-proj-face-machine="m1"');
    await expect(row).not.toHaveClass(/is-machine-offline/);
    const card = await hoverCardOf(page, "s-online");
    await expect(card).toContainText("On Mac Mini");
    await expect(card).not.toContainText("offline");
  });

  test("a mirrored offline head says so in its card, carries is-machine-offline, and dims", async ({ page }) => {
    await mountSessions(page);
    const row = page.locator('#sessions-list li[data-session-id="s-offline"]');
    await expect(row).toHaveClass(/is-machine-offline/);
    const localRow = page.locator('#sessions-list li[data-session-id="s-local"]');

    const [localOpacity, offlineOpacity] = await Promise.all([
      localRow.evaluate((el) => getComputedStyle(el).opacity),
      row.evaluate((el) => getComputedStyle(el).opacity),
    ]);
    expect(Number(offlineOpacity)).toBeLessThan(Number(localOpacity));

    await capture(page, "sidebar-machine-mark-desktop");
  });

  test("at 390px wide, an offline head is the same 44px circle as a local one", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await mountSessions(page);
    const [localBox, offlineBox] = await Promise.all([
      page.locator('#sessions-list li[data-session-id="s-local"]').boundingBox(),
      page.locator('#sessions-list li[data-session-id="s-offline"]').boundingBox(),
    ]);
    expect(localBox).not.toBeNull();
    expect(offlineBox).not.toBeNull();
    expect([Math.round(offlineBox!.width), Math.round(offlineBox!.height)]).toEqual([Math.round(localBox!.width), Math.round(localBox!.height)]);

    await capture(page, "sidebar-machine-mark-390");
  });

  test("desktop: no head ever renders a text machine label", async ({ page }) => {
    await mountSessions(page);
    await expect(page.locator("#sessions-list .session-machine-label")).toHaveCount(0);
  });

  // Phone (isRemote() true): the same heads, never a text label. The own-daemon glyph
  // the old phone rows carried has no head equivalent.
  test("phone: mirrored heads ask for their machine's project icon, the offline one dims, and no head has a text label", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await mountSessionsPhone(page);

    const head = (id: string) => page.locator(`#sessions-list li[data-session-id="${id}"]`);
    expect(await head("s-online").innerHTML()).toContain('data-proj-face-machine="m1"');
    expect(await head("s-local").innerHTML()).not.toContain("data-proj-face-machine");
    await expect(head("s-offline")).toHaveClass(/is-machine-offline/);
    await expect(page.locator("#sessions-list .session-machine-label")).toHaveCount(0);

    await capture(page, "sidebar-machine-mark-phone");
  });
});
