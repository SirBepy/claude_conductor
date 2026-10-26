import { expect, test } from "@playwright/test";
import { mountView } from "./harness";

// The Edit account modal restyles the shared appearance picker's tiles with a
// rule of equal specificity to the picker's own `.sel` rule, so the selected
// tile must still read as selected: filled with the account colour, never the
// dark page background behind a dark glyph.

const ACCOUNT = {
  id: "acc1", label: "personal", colour: "#57b894", icon: "robot",
  config_dir: "", chrome_profile_dir: "", email: "", org_uuid: "",
  subscription_tier: "", created_at: "", fleet_eligible: false,
  kind: "subscription" as const,
};

test("view-harness / edit account: the selected icon tile is filled with the account colour", async ({ page }) => {
  await mountView(page, { view: "settings" });
  await page.evaluate(async (account) => {
    const mod = await import("/views/settings/subviews/accounts/edit-account-modal.ts");
    void mod.openEditAccountModal(account);
  }, ACCOUNT);
  await page.locator(".aem-modal").waitFor();

  await page.locator('.aem-overlay .icon-tile[data-icon="flask"]').click();
  const selected = page.locator(".aem-overlay .icon-tile.sel");
  await expect(selected).toHaveAttribute("data-icon", "flask");

  const bg = await selected.evaluate((el) => getComputedStyle(el).backgroundColor);
  // #57b894, the account colour carried in --acc.
  expect(bg).toBe("rgb(87, 184, 148)");
});
