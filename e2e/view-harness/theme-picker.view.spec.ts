import { expect, test } from "@playwright/test";
import { capture, fireEvent, mountView } from "./harness";
import { SIRBEPY_PALETTES } from "../../vendor/tauri_kit/frontend/settings/palettes/sirbepy-default";

// asserts: src/views/settings/subviews/appearance/appearance.ts, src/shared/theme-sync.ts, src/shared/boot.ts

test("Appearance lists every kit palette and picking one repaints the window", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 900 });
  await mountView(page, { view: "settings-appearance" });

  const cards = page.locator("#themeGrid .kit-palette-card");
  await expect(cards).toHaveCount(SIRBEPY_PALETTES.length);

  await page.locator('#themeGrid .kit-palette-card[data-palette="nord"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "nord");
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  // The picked palette's own tokens resolve, i.e. its stylesheet is loaded.
  const bg = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--color-background").trim(),
  );
  expect(bg.toLowerCase()).toBe("#2e3440");

  await capture(page.locator(".view-settings-appearance .kit-section").first(), "theme-picker-nord-dark");
});

// The Chats window boots through the same initBoot path as the main window;
// it must follow a theme saved elsewhere via the app-wide settings-changed event.
test("a booted window follows settings-changed to a new theme", async ({ page }) => {
  await mountView(page, { view: "dashboard" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "void");

  await fireEvent(page, "settings-changed", [{ theme: "gruvbox-light" }]);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "gruvbox");
  await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
});

// Schedule and Preview pop-outs skip initBoot, so main.ts wires them itself:
// the saved theme on open, then every later change.
for (const [label, url] of [
  ["Schedule window", "/index.html?schedulewindow=1"],
  ["Preview window", "/index.html?previewwindow=1#preview?session=s1"],
] as const) {
  test(`${label} opens on the saved theme and follows settings-changed`, async ({ page }) => {
    await mountView(page, { invoke: { get_settings: { theme: "nord" } } });
    await page.goto(`http://localhost:4420${url}`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "nord");

    await fireEvent(page, "settings-changed", [{ theme: "dracula-light" }]);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dracula");
    await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
  });
}
