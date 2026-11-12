// Reviewed 2026-11-12: the card header's asker chip became an avatar for a sub and a "Main chat" chip for a main chat (C5, asker-face.ts); this spec's contract is unchanged and it passes.
// Reviewed 2026-11-08: shortcuts.ts gained the command-palette def and hasHandler/fire (Ctrl+Shift+P); this spec drives Settings only and passed after the change.
// Reviewed 2026-11-05: quiet daemon cards (a checkup yields, no dot), the mode-set nudge, the draft header dressing, the statusbar model sync and the sub-aware /close chip touch permission-modal and the sessions chrome; this spec's contract is unchanged and it passes.
// Reviewed 2026-11-05: permission-modal/gating.ts and index.ts gained hydrateSubchatsOn/isSubchatsOn/setSubchatsOn (the Use subchats toggle's in-memory state, hydrated at install time) - additive; the harness's unmocked list_subchats_on rejection is caught inside the hydrate, no change to this spec's contract.
// Reviewed 2026-11-07: the Skills row left the settings index (a skill is opened by clicking it), so the Skills back-arrow test reaches the page through showView instead of a row.
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
  get_settings_load_notice: null,
  list_installed_skills: [],
  list_projects: [],
};

/** The Chats window with a stand-in chat view underneath, and the standalone rail
 *  mounted the way boot does. */
async function mountChats(
  page: Page,
  size = { width: 1280, height: 800 },
  invoke: Record<string, unknown> = INVOKE,
): Promise<void> {
  await page.setViewportSize(size);
  await mountView(page, { view: "blank", invoke });
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
  // No Settings row leads to Skills any more: a skill chip opens a skill, and its Back arrow lands here.
  await page.evaluate(async () => (await import("/shared/navigation.ts")).showView("skills"));
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

// The chat stays mounted under the popup, so its document-level key handlers stay live:
// the keys typed at the popup must not reach them.
test("Escape on the popup leaves a permission card waiting behind it, and the next Escape reaches the card", async ({ page }) => {
  await mountChats(page);
  await page.evaluate(async () => {
    const pc = await import("/views/sessions/permission-modal/permission-card.ts");
    pc.showPermissionCard({ id: "p-1", session_id: "s1", tool_name: "Bash", input: { command: "ls" } } as never);
  });
  await expect(page.locator(".prompt-card")).toHaveCount(1);
  await openFromRail(page);

  await page.keyboard.press("Escape");
  await expect(popup(page)).toHaveCount(0);
  await expect(page.locator(".prompt-card")).toHaveCount(1);

  await page.keyboard.press("Escape");
  await expect(page.locator(".prompt-card")).toHaveCount(0);
});

test("Escape on the popup leaves a secret request waiting behind it", async ({ page }) => {
  await mountChats(page);
  await page.evaluate(async () => {
    const sc = await import("/views/sessions/permission-modal/secret-card.ts");
    sc.showSecretCard({ id: "sec-1", session_id: "s1", label: "API key", key: "API_KEY", file: "C:/x/.env" });
  });
  await expect(page.locator(".prompt-card")).toHaveCount(1);
  await openFromRail(page);

  await page.keyboard.press("Escape");
  await expect(popup(page)).toHaveCount(0);
  await expect(page.locator(".prompt-card")).toHaveCount(1);
});

test("Ctrl+Enter inside the popup does not submit a question card waiting behind it", async ({ page }) => {
  await mountChats(page);
  await page.evaluate(async () => {
    const qm = await import("/views/sessions/permission-modal/index.ts");
    await qm.showQuestionCard({
      id: "q-1",
      questions: [{ question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] }] as never,
    });
  });
  await expect(page.locator(".prompt-card")).toHaveCount(1);
  await page.locator('.prompt-card .prompt-panel[data-panel="0"] input[data-label="Yes"]').click();
  await openFromRail(page);

  await page.keyboard.press("Control+Enter");
  await expect(popup(page)).toBeVisible();
  // submit() on a single question removes the card, so give it a beat to have happened.
  await page.waitForTimeout(150);
  await expect(page.locator(".prompt-card")).toHaveCount(1);
});

test("Escape on the popup does not close Code mode under it", async ({ page }) => {
  await mountChats(page);
  const closes = await page.evaluate(async () => {
    const { createHandleKey } = await import("/views/sessions/code-mode/events.ts");
    let closed = 0;
    const handler = createHandleKey({
      root: document.createElement("div"),
      hooks: {},
      phone: false,
      menuOpen: false,
      branchOpen: false,
      close: () => { closed++; },
    } as never);
    document.addEventListener("keydown", handler, true);
    (await import("/shared/navigation.ts")).showView("settings");
    await new Promise((r) => setTimeout(r, 200));
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    return closed;
  });
  expect(closes).toBe(0);
  await expect(popup(page)).toHaveCount(0);
});

// The rail's buttons sit in the document behind the dimmed chat, so a Tab that walks off
// the popup's last control would land on them.
test("Tab and Shift+Tab cycle inside the popup and never reach the rail behind it", async ({ page }) => {
  await mountChats(page);
  await openFromRail(page);
  const inPopup = () => page.evaluate(() => !!document.activeElement?.closest(".settings-popup"));
  const focusables = await popup(page).locator("button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])").count();

  for (let i = 0; i < focusables + 4; i++) {
    await page.keyboard.press("Tab");
    expect(await inPopup(), `Tab #${i + 1} left the popup`).toBe(true);
  }
  for (let i = 0; i < focusables + 4; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(await inPopup(), `Shift+Tab #${i + 1} left the popup`).toBe(true);
  }

  // From the card itself (where open() leaves focus) Shift+Tab wraps to the last control.
  await popup(page).evaluate((el) => el.focus());
  await page.keyboard.press("Shift+Tab");
  expect(await inPopup()).toBe(true);
});

test("Tab inside an Add account wizard opened from the popup is left to the wizard", async ({ page }) => {
  await mountChats(page);
  await openFromRail(page);
  await page.evaluate(async () => (await import("/shared/navigation.ts")).showView("settings-accounts"));
  await popup(page).locator("#acc-add-btn").click();
  await page.locator('.aac-kind-choice[data-kind="subscription"]').click();
  await expectOnTop(page, ".aaw-overlay .wizard");
  await page.locator(".aaw-overlay .wizard").evaluate((el) => {
    const first = el.querySelector<HTMLElement>("button, input, select, textarea");
    first?.focus();
  });
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest(".aaw-overlay"))).toBe(true);
});

// The popup leaves the active view as "sessions", so without the input lock a sessions-context
// shortcut (ctrl+n, ctrl+w) would act on the chat dimmed behind it.
test("a sessions-context shortcut does nothing while the popup is open, and works again once it closes", async ({ page }) => {
  await mountChats(page);
  await page.evaluate(async () => {
    (window as any).__fired = 0;
    (await import("/shared/shortcuts.ts")).register("new-chat", () => { (window as any).__fired++; });
  });
  const fired = () => page.evaluate(() => (window as any).__fired as number);

  await page.keyboard.press("Control+n");
  expect(await fired()).toBe(1);

  await openFromRail(page);
  await page.keyboard.press("Control+n");
  await page.waitForTimeout(100);
  expect(await fired()).toBe(1);

  await page.keyboard.press("Escape");
  await expect(popup(page)).toHaveCount(0);
  await page.keyboard.press("Control+n");
  expect(await fired()).toBe(2);
});

test("Escape inside a settings text field blurs it and keeps the popup open; the next Escape closes it", async ({ page }) => {
  await mountChats(page);
  await openFromRail(page);
  await popup(page).evaluate((el) => {
    const input = document.createElement("input");
    input.type = "text";
    input.id = "probe-field";
    el.appendChild(input);
  });
  await page.locator("#probe-field").focus();

  await page.keyboard.press("Escape");
  await expect(popup(page)).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.id === "probe-field")).toBe(false);

  await page.keyboard.press("Escape");
  await expect(popup(page)).toHaveCount(0);
});

// The input lock swallows every key whose target is outside the popup, and with focus on
// <body> that is every key, Tab included. So the popup must never leave focus resting there.
const focusInPopupControl = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    const card = document.querySelector(".settings-popup");
    return !!a && !!card && a !== card && card.contains(a);
  });

test("Escape in a settings text field leaves focus on the popup, so Tab and Shift+Tab still reach its controls", async ({ page }) => {
  await mountChats(page);
  await openFromRail(page);
  await popup(page).evaluate((el) => {
    const input = document.createElement("input");
    input.type = "text";
    input.id = "probe-field";
    el.appendChild(input);
  });
  await page.locator("#probe-field").focus();

  await page.keyboard.press("Escape");
  await expect(popup(page)).toBeVisible();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);

  await page.keyboard.press("Tab");
  expect(await focusInPopupControl(page)).toBe(true);
  await popup(page).evaluate((el) => el.focus());
  await page.keyboard.press("Shift+Tab");
  expect(await focusInPopupControl(page)).toBe(true);
});

test("opening a settings page from the keyboard keeps focus in the popup, so Tab still reaches its controls", async ({ page }) => {
  await mountChats(page);
  await openFromRail(page);
  await popup(page).locator(".kit-nav-row", { hasText: "Appearance" }).focus();
  await page.keyboard.press("Enter");
  await expect(popup(page).locator(".view-settings-appearance")).toHaveCount(1);
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);

  await page.keyboard.press("Tab");
  expect(await focusInPopupControl(page)).toBe(true);
});

test("a settings page that re-renders and drops the focused control keeps focus in the popup", async ({ page }) => {
  await mountChats(page);
  await openFromRail(page);
  await popup(page).evaluate((el) => {
    const btn = document.createElement("button");
    btn.id = "probe-btn";
    btn.textContent = "probe";
    el.appendChild(btn);
  });
  await page.locator("#probe-btn").focus();
  await popup(page).evaluate(() => document.getElementById("probe-btn")!.remove());
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);

  await page.keyboard.press("Tab");
  expect(await focusInPopupControl(page)).toBe(true);
});

// The popup's input lock must not swallow input meant for what the popup itself opens.
test("typing works in the edit account modal opened from the popup, and Escape closes that modal first", async ({ page }) => {
  await mountChats(page);
  await openFromRail(page);
  await page.evaluate(async () => {
    const m = await import("/views/settings/subviews/accounts/edit-account-modal.ts");
    void m.openEditAccountModal({
      id: "acc1", label: "personal", colour: "#57b894", icon: "robot", config_dir: "", chrome_profile_dir: "",
      email: "", org_uuid: "", subscription_tier: "", created_at: "", fleet_eligible: false, kind: "subscription",
    } as never);
  });
  const label = page.locator("#aem-label");
  await label.click();
  await label.press("End");
  await page.keyboard.type("Z");
  expect(await label.inputValue()).toMatch(/Z$/);

  await page.keyboard.press("Escape");
  await expect(page.locator(".aem-overlay")).toHaveCount(0);
  await expect(popup(page)).toBeVisible();
});

test("the device icon picker opened from the popup is keyboard-driven: it takes focus, Arrow keys move it", async ({ page }) => {
  await mountChats(page, undefined, {
    ...INVOKE,
    remote_access_status: { enabled: true },
    list_remote_devices: [{ id: "d1", name: "Pixel 8", created_at: 1760000000, last_used: 1760100000, kind: "phone" }],
  });
  await openFromRail(page);
  await page.evaluate(async () => (await import("/shared/navigation.ts")).showView("settings-remote-access"));
  await popup(page).locator(".ra-icon-btn").first().click();
  const focusedInPicker = () => page.evaluate(() => document.activeElement?.closest(".ra-icon-pop") != null);
  expect(await focusedInPicker()).toBe(true);
  const before = await page.evaluate(() => document.activeElement?.getAttribute("data-icon") ?? "auto");
  await page.keyboard.press("ArrowDown");
  const after = await page.evaluate(() => document.activeElement?.getAttribute("data-icon") ?? "auto");
  expect(after).not.toBe(before);
  expect(await focusedInPicker()).toBe(true);
});

/** What a click at the centre of `selector` would land on is inside it, so the
 *  popup's backdrop is not covering it. */
async function expectOnTop(page: Page, selector: string): Promise<void> {
  await expect(page.locator(selector).first()).toBeVisible();
  const onTop = await page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && el.contains(hit);
  });
  expect(onTop, `${selector} is under the popup`).toBe(true);
}

// Each of these is appended to <body>, outside the popup's stacking context.
test("the Add account wizard opened from the popup lands on top of it", async ({ page }) => {
  await mountChats(page);
  await openFromRail(page);
  await page.evaluate(async () => (await import("/shared/navigation.ts")).showView("settings-accounts"));
  await popup(page).locator("#acc-add-btn").click();
  await page.locator('.aac-kind-choice[data-kind="subscription"]').click();
  await expectOnTop(page, ".aaw-overlay .wizard");
  await expect(popup(page)).toBeAttached();
});

test("the edit account modal opened from the popup lands on top of it", async ({ page }) => {
  await mountChats(page);
  await openFromRail(page);
  await page.evaluate(async () => {
    const m = await import("/views/settings/subviews/accounts/edit-account-modal.ts");
    void m.openEditAccountModal({ id: "a1", name: "Work", kind: "subscription", config_dir: "C:/x" } as never);
  });
  await expectOnTop(page, ".aem-overlay");
});

test("the device icon picker opened from the popup lands on top of it", async ({ page }) => {
  await mountChats(page, undefined, {
    ...INVOKE,
    remote_access_status: { enabled: true },
    list_remote_devices: [{ id: "d1", name: "Pixel 8", created_at: 1760000000, last_used: 1760100000, kind: "phone" }],
  });
  await openFromRail(page);
  await page.evaluate(async () => (await import("/shared/navigation.ts")).showView("settings-remote-access"));
  await popup(page).locator(".ra-icon-btn").first().click();
  await expectOnTop(page, ".ra-icon-pop");
});

test("a settings row's info tooltip shows above the popup", async ({ page }) => {
  await mountChats(page);
  await openFromRail(page);
  await page.evaluate(async () => (await import("/shared/navigation.ts")).showView("settings-usage-meter"));
  // Scrolling an icon into view dismisses the tooltip, so bring it in first and then hover.
  const icon = popup(page).locator(".info-icon").first();
  await icon.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await icon.hover();
  const tip = page.locator(".cc-row-tip");
  await expect(tip).toBeVisible();
  const z = await tip.evaluate((el) => Number(getComputedStyle(el).zIndex));
  const popupZ = await backdrop(page).evaluate((el) => Number(getComputedStyle(el).zIndex));
  expect(z).toBeGreaterThan(popupZ);
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
