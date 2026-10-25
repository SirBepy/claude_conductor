import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// asserts: src/views/sessions/statusbar-popover-shell.ts, src/views/sessions/session-statusbar.css
// On a phone a chip popover was centred on its chip and clamped, but the content
// classes carry desktop widths (up to 420px), so a wide one pinned left to the
// margin and ran off the right edge. On a phone every popover spans the screen
// edge to edge instead, whichever chip opened it.

const SESSIONS = [sessionInstance()];
const ROW = ["model", "effort", "duration"];

async function mountRow(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      set_session_effort: null,
      list_instances: SESSIONS,
      get_active_sessions: SESSIONS,
      get_settings: { theme: "void", statuslineRows: [ROW], statuslineRowsMobile: [ROW] },
    },
  });
  await page.locator(`#sessions-list li[data-session-id="s1"]`).click();
  await page.locator("#session-pane .sb-row").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
}

test.describe("view-harness / statusbar popover width on a phone", () => {
  test("a chip popover spans the phone screen with an 8px margin each side", async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await mountRow(page);
    await page.locator("#session-pane .sb-model-btn").first().click();
    const pop = page.locator(".sb-popover").first();
    await pop.waitFor();
    const box = await pop.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box!.x)).toBe(8);
    expect(Math.round(box!.x + box!.width)).toBe(393 - 8);
  });

  test("on desktop the popover keeps its own width, centred on the chip", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mountRow(page);
    await page.locator("#session-pane .sb-model-btn").first().click();
    const pop = page.locator(".sb-popover").first();
    await pop.waitFor();
    const box = await pop.boundingBox();
    expect(box!.width).toBeLessThan(600);
    await expect(pop).not.toHaveClass(/sb-popover--full/);
  });
});
