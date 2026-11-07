import { expect, test, type Page } from "@playwright/test";
import { mountView } from "./harness";
import { shotDir } from "./shot-dir";

// asserts: src/shared/chat/caret-popup/popup.css, src/shared/chat/caret-popup/popup.ts, src/shared/chat/caret-popup/providers/slash.ts
// A user-skill or plugin-skill row of the "/" menu has a small info icon that opens the
// skill's detail; the row itself still picks. The icon is --control-h-sm on desktop and
// the 44px phone floor (--control-h) on a phone, and a command or builtin gets none.

const SHOT_DIR = shotDir();

const ENTRIES = [
  { name: "brainstorm", args: null, description: "Explore intent before building", source: { kind: "plugin-skill", plugin: "superpowers" }, path: null },
  { name: "close", args: null, description: "Session retrospective and wrap-up", source: { kind: "user-skill" }, path: null },
  { name: "cleanup", args: null, description: "A user command with no detail page", source: { kind: "user-command" }, path: null },
  { name: "clear", args: null, description: "Clear the conversation", source: { kind: "builtin" }, path: null },
];

async function openMenu(page: Page): Promise<void> {
  await mountView(page, { invoke: { list_slash_commands: ENTRIES } });
  await page.evaluate(async () => {
    await import("/shared/chat/caret-popup/popup.css");
    const { CaretSuggestPopup } = await import("/shared/chat/caret-popup/popup.ts");
    const { SlashProvider } = await import("/shared/chat/caret-popup/providers/slash.ts");
    const anchor = document.createElement("div");
    anchor.style.cssText = "position:fixed;left:16px;right:16px;bottom:200px;";
    const ta = document.createElement("textarea");
    ta.id = "ta";
    anchor.appendChild(ta);
    document.body.appendChild(anchor);
    const provider = new SlashProvider();
    await provider.start(null);
    const popup = new CaretSuggestPopup({ anchor, textarea: ta, providers: [provider] });
    ta.addEventListener("input", () => popup.handleInput());
    ta.focus();
  });
  await page.locator("#ta").fill("/");
  await expect(page.locator(".caret-popup .row").first()).toBeVisible();
}

const box = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!;

test.describe("view-harness / slash menu skill info icon", () => {
  test("desktop: icons on skill rows only, 24px, vertically centred in the row", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await openMenu(page);
    const rows = page.locator(".caret-popup .row");
    await expect(rows).toHaveCount(4);
    await expect(page.locator(".caret-popup .skill-info")).toHaveCount(2);
    await expect(rows.filter({ hasText: "/cleanup" }).locator(".skill-info")).toHaveCount(0);
    await expect(rows.filter({ hasText: "/clear" }).locator(".skill-info")).toHaveCount(0);

    const b = await box(page, ".caret-popup .skill-info");
    expect(Math.round(b.width)).toBe(24);
    expect(Math.round(b.height)).toBe(24);
    const r = await box(page, ".caret-popup .row.has-info");
    expect(Math.abs((b.y + b.height / 2) - (r.y + r.height / 2))).toBeLessThan(1.5);
    // The one-line description stops before the icon instead of running under it.
    const metaRight = await page.evaluate(() => document.querySelector(".caret-popup .row.has-info .meta")!.getBoundingClientRect().right);
    expect(metaRight).toBeLessThanOrEqual(b.x);
    await page.screenshot({ path: `${SHOT_DIR}/slash-skill-info-desktop.png` });
  });

  test("phone: the icon is the 44px touch target and stays inside its row", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await openMenu(page);
    const b = await box(page, ".caret-popup .skill-info");
    expect(Math.round(b.width)).toBe(44);
    expect(Math.round(b.height)).toBe(44);
    const inside = await page.evaluate(() => {
      const row = document.querySelector(".caret-popup .row.has-info")!.getBoundingClientRect();
      const btn = document.querySelector(".caret-popup .skill-info")!.getBoundingClientRect();
      return btn.top >= row.top - 0.5 && btn.bottom <= row.bottom + 0.5;
    });
    expect(inside).toBe(true);
    await page.screenshot({ path: `${SHOT_DIR}/slash-skill-info-phone.png` });
  });

  test("clicking the icon opens that skill's detail and leaves the draft alone; clicking the row picks", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await openMenu(page);
    await page.locator(".caret-popup .row", { hasText: "/superpowers:brainstorm" }).locator(".skill-info").click();
    await expect(page.locator(".caret-popup")).toBeHidden();
    await expect(page.locator("#ta")).toHaveValue("/");
    // The opener is imported lazily, so the target lands a tick after the click.
    await expect.poll(() => page.evaluate(() => (window as unknown as { skillDetailTarget?: string }).skillDetailTarget)).toBe("superpowers:brainstorm");

    await page.locator("#ta").fill("/cl");
    await page.locator(".caret-popup .row", { hasText: "/close" }).locator(".head").click();
    await expect(page.locator("#ta")).toHaveValue("/close ");
  });
});
