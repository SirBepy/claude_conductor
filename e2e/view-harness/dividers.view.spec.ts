// asserts: src/styles/dividers.css, src/views/settings/subviews/notifications/notifications.ts
import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";

// The dividers look: section groups are separated by a hairline above each
// one, with no card box (fill, radius, shadow).
const box = (page: Page, sel: string) =>
  page.locator(sel).evaluateAll((els) => els
    .filter((e) => (e as HTMLElement).offsetParent !== null)
    .map((e) => {
      const cs = getComputedStyle(e);
      return { bg: cs.backgroundColor, radius: cs.borderTopLeftRadius, shadow: cs.boxShadow, top: cs.borderTopWidth, left: cs.borderLeftWidth };
    }));

test.describe("view-harness / dividers look", () => {
  test("Settings sections have no card box and a hairline between them", async ({ page }) => {
    await mountView(page, { view: "settings" });
    await expect(page.locator(".kit-section").first()).toBeVisible();
    const secs = await box(page, ".kit-section");
    expect(secs.length).toBeGreaterThan(1);
    for (const s of secs) {
      expect(s.bg).toBe("rgba(0, 0, 0, 0)");
      expect(s.radius).toBe("0px");
      expect(s.shadow).toBe("none");
      expect(s.left).toBe("0px");
    }
    // The first section sits under the header's own rule; the rest draw one.
    expect(secs[0]!.top).toBe("0px");
    for (const s of secs.slice(1)) expect(s.top).toBe("1px");
  });

  test("a section opening a nested list keeps its hairline", async ({ page }) => {
    await mountView(page, { view: "settings-notifications" });
    await expect(page.locator(".notif-card").first()).toBeVisible();
    const cards = await box(page, ".notif-card");
    expect(cards[0]!.top).toBe("1px");
  });
});
