// asserts: src/shared/settings-popup.ts, src/shared/app-rail.ts, src/shared/navigation.ts, src/router.ts, src/views/settings/settings.ts, src/views/settings/ui.ts
import { expect, test, type Page } from "@playwright/test";
import { fireEvent, mountView } from "./harness";
import { shotDir } from "./shot-dir";

// Settings in the Chats window is a centered 560px popup over the chat instead of a
// full screen (Joe, 2026-11-02). Real clicks on the real rail and the real settings
// rows, against the real router.

const SHOT_DIR = shotDir();

const INVOKE = {
  list_accounts: [],
  get_account_identity: { oauthAccount: null, tokenExpiresAt: null, refreshTokenExpiresAt: null, hasCookie: false, drift: false, driftMessage: null },
  get_auth_state_map: {},
  get_terminal_identity: null,
  list_api_keys: [],
  get_api_credit_status: {},
  get_app_version: "0.2.137",
  list_characters: [],
  list_machines: { self: { machine_id: "m0", label: "Desktop", os: "windows" }, peers: [] },
  list_remote_devices: [],
  remote_access_status: { enabled: false },
  remote_access_qr: { svg: "<svg width='80' height='80'></svg>", url: "http://x/pair", iroh: null },
  list_auto_accept: [],
  list_wrap_up_on_done: [],
  get_settings_load_notice: null,
  list_installed_skills: [],
  list_projects: [],
};

/** The Chats window with a stand-in chat view underneath, and the standalone rail
 *  mounted the way boot does. */
async function mountChats(page: Page, size = { width: 1280, height: 800 }): Promise<void> {
  await page.setViewportSize(size);
  await mountView(page, { view: "blank", invoke: INVOKE });
  await page.evaluate(async () => {
    document.body.classList.add("chats-window-mode");
    const chat = document.createElement("main");
    chat.id = "fake-chat";
    chat.style.cssText = "position:fixed;inset:0 44px 0 0;background:#14141c";
    chat.textContent = "chat";
    document.body.appendChild(chat);
    (await import("/shared/navigation.ts")).setActiveView("sessions");
    const rail = await import("/shared/app-rail.ts");
    rail.mountAppRail();
    rail.syncAppRail("sessions");
  });
}

const popup = (page: Page) => page.locator(".settings-popup");
const backdrop = (page: Page) => page.locator(".settings-popup-backdrop");
const railSettings = (page: Page) => page.locator('#app-rail [data-rail-go="settings"]');

async function openFromRail(page: Page): Promise<void> {
  await railSettings(page).click();
  await expect(popup(page)).toBeVisible();
  await expect(popup(page).locator(".view-settings")).toHaveCount(1);
}

test("the rail's Settings opens a 560px popup centred over the chat, which stays where it was", async ({ page }) => {
  await mountChats(page);
  await openFromRail(page);

  const box = (await popup(page).boundingBox())!;
  expect(Math.round(box.width)).toBe(560);
  expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.y + box.height / 2 - 400)).toBeLessThanOrEqual(1);
  expect(box.height).toBeLessThanOrEqual(660);
  expect(box.y).toBeGreaterThanOrEqual(24);

  const bd = await backdrop(page).evaluate((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { bg: cs.backgroundColor, z: Number(cs.zIndex), w: r.width, h: r.height };
  });
  expect(bd.bg).toBe("rgba(0, 0, 0, 0.55)");
  expect(bd.z).toBeGreaterThanOrEqual(2500);
  expect([bd.w, bd.h]).toEqual([1280, 800]);

  // The chat view is untouched: still mounted, still the active view, and Settings
  // did not render into the router's mount point.
  await expect(page.locator("#fake-chat")).toBeAttached();
  expect(await page.evaluate(async () => (await import("/shared/navigation.ts")).getActiveView())).toBe("sessions");
  await expect(page.locator("#app .view-settings")).toHaveCount(0);
  await expect(railSettings(page)).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: `${SHOT_DIR}/settings-popup-index.png` });
});

test("a settings row opens its subpage inside the popup, and that page's back button returns to the index there", async ({ page }) => {
  await mountChats(page);
  await openFromRail(page);

  await popup(page).locator(".kit-nav-row", { hasText: "Appearance" }).click();
  await expect(popup(page).locator(".view-settings-appearance")).toHaveCount(1);
  await expect(popup(page).locator(".view-settings")).toHaveCount(0);
  await expect(popup(page)).toHaveCount(1);
  expect(Math.round((await popup(page).boundingBox())!.width)).toBe(560);
  await page.screenshot({ path: `${SHOT_DIR}/settings-popup-subpage.png` });

  await popup(page).locator(".back-to-settings").click();
  await expect(popup(page).locator(".view-settings")).toHaveCount(1);
  await expect(popup(page).locator(".view-settings-appearance")).toHaveCount(0);
  await expect(page.locator("#fake-chat")).toBeAttached();
  await expect(page.locator("#app .view")).toHaveCount(0);
});

test("Skills, whose header has a burger, gets a back arrow in the popup that returns to Settings", async ({ page }) => {
  await mountChats(page);
  await openFromRail(page);
  await popup(page).locator(".kit-nav-row", { hasText: "Skills" }).click();
  await expect(popup(page).locator(".view-skills")).toHaveCount(1);
  await expect(popup(page).locator(".view-header .burger")).toBeHidden();

  await popup(page).locator(".settings-popup-back").click();
  await expect(popup(page).locator(".view-settings")).toHaveCount(1);
  await expect(popup(page).locator(".settings-popup-back")).toBeHidden();
});

test("the X, Escape and a click on the backdrop each close it; a click on the card does not", async ({ page }) => {
  await mountChats(page);
  await openFromRail(page);
  await popup(page).locator(".view-header h2").click();
  await expect(popup(page)).toBeVisible();

  await popup(page).locator(".settings-popup-close").click();
  await expect(popup(page)).toHaveCount(0);

  await openFromRail(page);
  await page.keyboard.press("Escape");
  await expect(popup(page)).toHaveCount(0);

  await openFromRail(page);
  await page.mouse.click(40, 400);
  await expect(popup(page)).toHaveCount(0);

  // Closing leaves the chat as it was and un-presses the rail.
  await expect(page.locator("#fake-chat")).toBeAttached();
  await expect(railSettings(page)).toHaveAttribute("aria-pressed", "false");
});

test("closing, and moving to another page, call the shown view's teardown", async ({ page }) => {
  await mountChats(page);
  await page.evaluate(async () => {
    // A stand-in index with a teardown we can count; the subpage is the real one.
    (window as any).__torn = 0;
    (await import("/router.ts")).registerView("settings", (root: HTMLElement) => {
      root.innerHTML = '<div class="view view-settings"><div class="view-header"><h2>Settings</h2></div></div>';
      return () => { (window as any).__torn++; };
    });
  });
  await openFromRail(page);
  await page.evaluate(async () => (window as any).navigateTo("settings-appearance"));
  await expect(popup(page).locator(".view-settings-appearance")).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__torn)).toBe(1);

  await page.evaluate(async () => (window as any).navigateTo("settings"));
  await expect(popup(page).locator(".view-settings")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator(".settings-popup-backdrop")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__torn)).toBe(2);
});

test("the pressed rail entry closes it when clicked again", async ({ page }) => {
  await mountChats(page);
  await openFromRail(page);
  // The backdrop covers the rail, so deliver the click straight to the entry.
  await railSettings(page).dispatchEvent("click");
  await expect(popup(page)).toHaveCount(0);
});

test("the accounts route opens the popup straight on the accounts subpage", async ({ page }) => {
  await mountChats(page);
  await fireEvent(page, "navigate-to-settings-accounts", [null]);
  await expect(popup(page).locator(".view-settings-accounts")).toHaveCount(1);
  expect(Math.round((await popup(page).boundingBox())!.width)).toBe(560);
  await expect(page.locator("#app .view")).toHaveCount(0);

  await popup(page).locator(".back-to-settings").click();
  await expect(popup(page).locator(".view-settings")).toHaveCount(1);
});

test("the popup caps to a short window and its page scrolls inside it", async ({ page }) => {
  await mountChats(page, { width: 1280, height: 500 });
  await openFromRail(page);
  const box = (await popup(page).boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(8);
  expect(box.y + box.height).toBeLessThanOrEqual(500 - 8);
  const body = await popup(page).locator(".view-settings .view-body").evaluate((el) => ({
    scroll: el.scrollHeight, client: el.clientHeight,
  }));
  expect(body.scroll).toBeGreaterThan(body.client);
  // Not the page: the window itself does not scroll.
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
});

test("opening it leaves an open Dashboard panel as it is; navigating to another screen closes it", async ({ page }) => {
  await mountChats(page);
  await page.evaluate(async () => (await import("/shared/global-panel.ts")).setGlobalPanel("dashboard"));
  await openFromRail(page);
  expect(await page.evaluate(async () => (await import("/shared/global-panel.ts")).getGlobalPanel())).toBe("dashboard");

  await page.evaluate(async () => (await import("/shared/navigation.ts")).showView("sessions"));
  await expect(popup(page)).toHaveCount(0);
});

test("outside the Chats window Settings stays the full-screen view", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mountView(page, { view: "blank", invoke: INVOKE });
  await page.evaluate(async () => (await import("/shared/navigation.ts")).showView("settings"));
  await expect(page.locator("#app .view-settings")).toHaveCount(1);
  await expect(popup(page)).toHaveCount(0);

  await page.locator("#app .kit-nav-row", { hasText: "Appearance" }).click();
  await expect(page.locator("#app .view-settings-appearance")).toHaveCount(1);
  await expect(popup(page)).toHaveCount(0);
});
