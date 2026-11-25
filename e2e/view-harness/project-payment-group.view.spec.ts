// Reviewed 2026-11-25 (a Who does what row shows its Claude model's level and its limit and flexible chips, and a rule left on Default names what it runs): the project rail's Payment group block and role sheet assert none of that, and this spec passes.
import { test, expect, type Page } from "@playwright/test";
import { capture, invokeCalls, mountView } from "./harness";

// asserts: src/views/sessions/project-dashboard/project-config/payment-group-row.ts, src/views/sessions/project-dashboard/project-config/override-rows.ts, src/views/sessions/project-dashboard/project-config/role-override-sheet.ts, src/views/sessions/project-dashboard/project-config/project-settings.ts, src/views/sessions/project-dashboard/project-config/project-settings.css, src/views/settings/subviews/models-providers/sheet-controller.ts, src/views/settings/subviews/models-providers/keyed-list.ts, src/views/settings/subviews/models-providers/models-providers.css, src/shared/routing-rules.ts

// The project rail's Payment group block in the browser harness: the group
// select, the rows of overridden kinds, the "Change a role" menu and the role
// sheet a row or a menu pick opens.

const CWD = "C:/work/demo";
const SUB = {
  id: "acct-sub", label: "Claude personal", colour: "#d97757", icon: "sparkle", config_dir: "", chrome_profile_dir: "",
  email: "joe@example.com", org_uuid: "org-1", subscription_tier: "claude_max", created_at: "2026-01-01T00:00:00Z",
  fleet_eligible: false, kind: "subscription",
};
const DEEPSEEK = {
  id: "acct-ds", label: "DeepSeek", colour: "#6f86ff", icon: "key", config_dir: "", chrome_profile_dir: "", email: "", org_uuid: "",
  subscription_tier: "", created_at: "2026-11-23T00:00:00Z", fleet_eligible: false, kind: "endpoint",
  endpoint: { preset: "deepseek", base_url: "https://api.deepseek.com/anthropic", auth_style: "bearer", models: ["deepseek-v4-pro", "deepseek-flash"] },
};
const ROUTING = {
  groups: {
    personal: { build: { account_id: "acct-sub", model: "opus", effort: "high" } },
    client: { build: { account_id: "acct-sub", model: "sonnet" } },
  },
};

async function mount(page: Page, project: Record<string, unknown> = {}): Promise<void> {
  await page.setViewportSize({ width: 700, height: 1100 });
  await mountView(page, {
    view: "settings-appearance",
    invoke: {
      list_accounts: [SUB, DEEPSEEK],
      resolve_project_account: null,
      get_ticket_tracker: null,
      list_projects: [{ id: "p1", path: CWD, name: "demo", ...project }],
      get_settings: { routing: ROUTING },
      update_project: null,
      ensure_project: { id: "p1", path: CWD },
    },
  });
  await page.locator(".kit-row").first().waitFor();
  await page.evaluate(async (cwd) => {
    await import("/views/sessions/project-dashboard/pd-cards.css");
    const { renderProjectSettings } = await import("/views/sessions/project-dashboard/project-config/project-settings.ts");
    const host = document.createElement("div");
    host.id = "rail";
    host.style.cssText = "width:270px;padding:16px;position:absolute;top:0;left:0;background:var(--color-background)";
    document.body.appendChild(host);
    await renderProjectSettings(host, cwd);
  }, CWD);
  await page.locator("#rail #paymentGroupSelect").waitFor();
}

type Patch = { id: string; patch: Record<string, unknown> };
async function patches(page: Page): Promise<Patch[]> {
  return (await invokeCalls(page)).filter((c) => c.cmd === "update_project").map((c) => c.args as Patch);
}
const lastPatch = async (page: Page, key: string): Promise<Record<string, unknown> | undefined> =>
  (await patches(page)).filter((p) => key in p.patch).at(-1)?.patch;

const rows = (page: Page) => page.locator("#paymentGroupRows .mp-diff");
const menuItems = (page: Page) => page.locator("#paymentGroupMenu .menu-item");

async function pickKind(page: Page, label: string): Promise<void> {
  await page.locator("#paymentGroupAdd").click();
  await page.locator("#paymentGroupMenu .menu-item", { hasText: label }).click();
  await page.locator(".mp-pop").waitFor();
}

test.describe("view-harness / project payment group", () => {
  test("a project with no overrides reads Personal, says every role follows the group and offers every kind", async ({ page }) => {
    await mount(page);
    await expect(page.locator("#paymentGroupSelect")).toHaveValue("personal");
    await expect(rows(page)).toHaveCount(0);
    await expect(page.locator("#paymentGroupEmpty")).toHaveClass(/\bon\b/);
    await expect(page.locator("#paymentGroupEmpty")).toContainText("Every role uses the Personal payment group.");
    await expect(page.locator("#paymentGroupEdit")).toContainText("Edit the Personal roles");
    await page.waitForTimeout(450);
    await capture(page.locator("#rail"), "pg-rail-no-overrides");
  });

  test("the group select saves payment_group and the link follows it", async ({ page }) => {
    await mount(page);
    await page.locator("#paymentGroupSelect").selectOption("client");
    await expect.poll(() => lastPatch(page, "payment_group")).toEqual({ payment_group: "client" });
    await expect(page.locator("#paymentGroupEdit")).toContainText("Edit the Client roles");
    await expect(page.locator("#paymentGroupEmpty")).toContainText("Client payment group");
  });

  test("the menu lists every kind, and a pick that is only looked at saves no override", async ({ page }) => {
    await mount(page);
    await page.locator("#paymentGroupAdd").click();
    await expect(page.locator("#paymentGroupMenu")).toBeVisible();
    await expect(menuItems(page)).toHaveCount(13);
    await page.waitForTimeout(250);
    await capture(page.locator("body"), "pg-menu-open");
    await menuItems(page).filter({ hasText: "Build" }).click();
    const sheet = page.locator(".mp-pop");
    await sheet.waitFor();
    // Seeded from the group's rule, so the sheet opens showing what the project gets today.
    await expect(sheet.locator("#sh-model")).toHaveValue("opus");
    await expect(sheet).toContainText("Only for demo. Other projects keep using the personal payment group.");
    await page.locator(".mp-pop-done").click();
    await expect(sheet).toHaveCount(0);
    await expect(rows(page)).toHaveCount(0);
    expect(await patches(page)).toEqual([]);
  });

  test("setting a model in the sheet adds an override row and leaves the menu without that kind", async ({ page }) => {
    await mount(page);
    await pickKind(page, "Build");
    await page.locator("#sh-acc").selectOption("acct-ds");
    await page.locator("#sh-model").selectOption("deepseek-flash");
    await expect.poll(() => lastPatch(page, "routing_overrides")).toEqual({
      routing_overrides: { build: { account_id: "acct-ds", model: "deepseek-flash", effort: "high" } },
    });
    await page.waitForTimeout(450);
    await capture(page.locator("body"), "pg-sheet-open");
    await page.locator(".mp-pop-done").click();
    await expect(page.locator(".mp-pop")).toHaveCount(0);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText("Build");
    await expect(rows(page).first()).toContainText("deepseek-flash");
    await expect(rows(page).first()).toContainText("instead of Opus");
    await expect(page.locator("#paymentGroupEmpty")).not.toHaveClass(/\bon\b/);
    await page.locator("#paymentGroupAdd").click();
    await expect(menuItems(page)).toHaveCount(12);
    await expect(menuItems(page).filter({ hasText: "Build" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(450);
    await capture(page.locator("#rail"), "pg-rail-one-override");
  });

  test("an existing override opens from its row and Back to the group removes it", async ({ page }) => {
    await mount(page, { routing_overrides: { build: { account_id: "acct-ds", model: "deepseek-v4-pro" } } });
    await expect(rows(page)).toHaveCount(1);
    await rows(page).first().click();
    await expect(page.locator(".mp-pop #sh-model")).toHaveValue("deepseek-v4-pro");
    await page.locator(".mp-pop-reset").click();
    await expect(page.locator(".mp-pop")).toHaveCount(0);
    await expect.poll(() => lastPatch(page, "routing_overrides")).toEqual({ routing_overrides: {} });
    await expect(rows(page)).toHaveCount(0);
    await expect(page.locator("#paymentGroupEmpty")).toHaveClass(/\bon\b/);
  });

  test("hovering a row or the add button moves no box, and the row declares its transitions", async ({ page }) => {
    await mount(page, { routing_overrides: { build: { account_id: "acct-ds", model: "deepseek-v4-pro" } } });
    await page.waitForTimeout(450);
    // The caret's 2px nudge is a transform, not layout: every other box of the row must not move.
    const boxes = async () => page.evaluate(() => [...document.querySelectorAll("#rail .mp-diff, #rail .mp-diff *:not(.mp-go), #rail .ps-add")].map((e) => {
      const r = e.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 10) / 10);
    }));
    const rest = await boxes();
    await rows(page).first().hover();
    await page.waitForTimeout(300);
    expect(await boxes()).toEqual(rest);
    await page.locator("#paymentGroupAdd").hover();
    await page.waitForTimeout(300);
    expect(await boxes()).toEqual(rest);
    const transition = await rows(page).first().evaluate((e) => getComputedStyle(e).transitionProperty);
    expect(transition).toContain("border-color");
    // The keyed list wraps each row in an .mp-li whose enter and leave fold animates grid-template-rows (keyed-list.ts).
    const fold = await page.locator("#paymentGroupRows .mp-li").first().evaluate((e) => getComputedStyle(e).transitionProperty);
    expect(fold).toContain("grid-template-rows");
  });

  test("the menu stays inside the window when the add button sits near the bottom edge", async ({ page }) => {
    await mount(page);
    await page.setViewportSize({ width: 700, height: 420 });
    await page.locator("#paymentGroupAdd").scrollIntoViewIfNeeded();
    await page.locator("#paymentGroupAdd").click();
    const box = await page.locator("#paymentGroupMenu").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(420);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(700);
  });
});
