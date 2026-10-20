import { expect, test } from "@playwright/test";
import { capture, fireEvent, mountView } from "./harness";
import { SIRBEPY_PALETTES } from "../../vendor/tauri_kit/frontend/settings/palettes/sirbepy-default";

// asserts: src/views/settings/subviews/appearance/appearance.ts, src/views/settings/subviews/appearance/theme-picker.ts, src/shared/theme-sync.ts, src/shared/boot.ts

const bgOf = (sel: string) => (page: import("@playwright/test").Page) =>
  page.locator(sel).evaluate((el) => getComputedStyle(el).backgroundColor);

// Joe's real Settings window width, where the picker has to fit.
test.use({ viewport: { width: 474, height: 900 } });

test("hovering a palette previews it without applying; clicking applies it", async ({ page }) => {
  await mountView(page, { view: "settings-appearance" });

  const options = page.locator("#themePicker .tp-option");
  await expect(options).toHaveCount(SIRBEPY_PALETTES.length);
  // Every palette is labelled by name, not just by colour.
  await expect(options).toHaveText(SIRBEPY_PALETTES.map((p) => p.label));
  await expect(page.locator("#themePicker .tp-group")).toHaveText(["SirBepy", "Editor classics"]);

  // Hover: only the preview repaints, to Gruvbox's dark background.
  await page.locator('.tp-option[data-palette="gruvbox"]').hover();
  await expect(page.locator(".tp-preview")).toHaveAttribute("data-theme", "gruvbox");
  await expect(page.locator("#themeName")).toHaveText("Gruvbox");
  // Polled: the preview cross-fades its background.
  await expect.poll(() => bgOf(".tp-preview")(page)).toBe("rgb(29, 32, 33)");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "void");

  // Leaving the palette puts the preview back on the applied theme.
  await page.mouse.move(2, 2);
  await expect(page.locator(".tp-preview")).toHaveAttribute("data-theme", "void");

  // Click applies to the whole window and marks the row.
  await page.locator('.tp-option[data-palette="nord"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "nord");
  await expect(page.locator('.tp-option[data-palette="nord"]')).toHaveAttribute("aria-pressed", "true");
  const bg = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--color-background").trim(),
  );
  expect(bg.toLowerCase()).toBe("#2e3440");

  // Light switch keeps the palette and flips the mode everywhere.
  await page.locator('#themeModeSeg button[data-mode="light"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
  await expect(page.locator(".tp-preview")).toHaveAttribute("data-mode", "light");
  await expect.poll(() => bgOf(".tp-preview")(page)).toBe("rgb(229, 233, 240)");

  await page.mouse.move(2, 2);
  await capture(page.locator(".view-settings-appearance .kit-section").first(), "theme-picker-nord-light");
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
