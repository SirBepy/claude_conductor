import { expect, test } from "@playwright/test";
import path from "node:path";
import { mountViewPhone } from "./harness";
import { shotDir } from "./shot-dir";

// asserts: src/views/settings/subviews/about/about.ts, src/shared/shell-version.ts
// On the phone, Settings > About names both ends: the PC app (answered by the
// daemon's get_version_info) and the installed Android app (kept from the
// shell's ?shellv= param).

const SHOT_DIR = shotDir();
const INVOKE = {
  get_version_info: { version: "0.2.145", build_date: "2026-11-05", installed_at: null },
  get_update_state: { state: "up-to-date" },
  get_settings_load_notice: null,
};

test.use({ viewport: { width: 390, height: 844 } });

test("phone About shows the PC app version and the Android app version", async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem("conductor_shell_version", "0.2.145"); } catch { /* ignore */ }
  });
  await mountViewPhone(page, { view: "settings-about", invoke: INVOKE });
  await page.locator(".about-pc-version").waitFor();
  await expect(page.locator(".about-pc-version")).toHaveText("v0.2.145");
  await expect(page.locator(".about-phone-version")).toHaveText("v0.2.145");
  await page.screenshot({ path: path.join(SHOT_DIR, "about-phone-versions.png"), fullPage: true });
});

test("phone About says the app version was not reported when the shell never sent one", async ({ page }) => {
  await mountViewPhone(page, { view: "settings-about", invoke: INVOKE });
  await page.locator(".about-phone-version").waitFor();
  await expect(page.locator(".about-phone-version")).toContainText("Not reported");
});
