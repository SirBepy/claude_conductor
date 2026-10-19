// asserts: src/views/settings/subviews/system/nightly.ts

// `.kit-row` is `justify-content: space-between` over its direct children,
// so the "Give up waiting after [N] hours" row keeps exactly two: the label,
// and one inline-flex span holding the number input and its "hours" unit.
// A third direct child would land the input in the leftover middle gap,
// away from its unit; with two, the pair sits together at the right edge.

import { test, expect } from "@playwright/test";
import { mountView, capture } from "./harness";

const INVOKE = {
  get_settings: {
    theme: "void",
    nightlyWhenDone: {
      enabled: true,
      action: "shutdown",
      time: "02:00",
      overdueHours: 5,
      overdueAction: "cancel",
    },
  },
  get_storage_info: [],
  list_api_keys: [],
};

test("the overdue-hours input and its unit sit together at the row's right edge", async ({ page }) => {
  await mountView(page, { view: "settings-system", invoke: INVOKE });

  const row = page.locator(".kit-row", { has: page.locator("#nightlyWhenDoneOverdueHours") });
  const input = row.locator("#nightlyWhenDoneOverdueHours");
  const hoursLabel = row.locator(".kit-row-label", { hasText: "hours" });
  await expect(input).toBeVisible();

  const rowBox = await row.boundingBox();
  const inputBox = await input.boundingBox();
  const hoursBox = await hoursLabel.boundingBox();
  expect(rowBox).not.toBeNull();
  expect(inputBox).not.toBeNull();
  expect(hoursBox).not.toBeNull();

  // The "hours" label's right edge sits at the row's own right edge
  // (`.kit-row` has no horizontal padding, so content-box == border-box here).
  const rowRight = rowBox!.x + rowBox!.width;
  const hoursRight = hoursBox!.x + hoursBox!.width;
  expect(Math.abs(rowRight - hoursRight)).toBeLessThanOrEqual(4);

  // The input's left edge sits well past the row's midpoint, not floating in
  // the middle of the row the way it did before the wrapper span.
  const rowMid = rowBox!.x + rowBox!.width / 2;
  expect(inputBox!.x).toBeGreaterThan(rowMid + 40);

  const section = page.locator(".kit-section", { hasText: "Nightly" }).first();
  await capture(section, "1234-nightly-overdue-rows-fixed");
});
