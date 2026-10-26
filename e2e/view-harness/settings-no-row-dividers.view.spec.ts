import { expect, test } from "@playwright/test";
import path from "node:path";
import { mountView } from "./harness";
import { shotDir } from "./shot-dir";

// asserts: src/styles/settings-sections.css
// Settings cards draw no hairline between rows. The kit's per-row divider
// skipped only a card's :last-of-type row, so a row followed by a caption or a
// button kept its line and cards showed lines under some rows and not others.

const SHOT_DIR = shotDir();
const LABEL = process.env.CC_SHOT_LABEL ?? "after";

test("settings rows draw no divider lines", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  await mountView(page, { view: "settings-appearance" });
  await page.locator(".kit-row").first().waitFor();

  const rows = await page.locator(".kit-row, .option").evaluateAll((els) =>
    els.map((el) => {
      const cs = getComputedStyle(el);
      return {
        label: el.querySelector(".kit-row-label")?.textContent?.trim() ?? el.className,
        top: cs.borderTopWidth,
        bottom: cs.borderBottomWidth,
      };
    }),
  );
  await page.screenshot({ path: path.join(SHOT_DIR, `settings-no-row-dividers-${LABEL}.png`), fullPage: true });

  expect(rows.length).toBeGreaterThan(1);
  for (const r of rows) {
    expect(r.bottom, `row "${r.label}" bottom border`).toBe("0px");
    expect(r.top, `row "${r.label}" top border`).toBe("0px");
  }
});
