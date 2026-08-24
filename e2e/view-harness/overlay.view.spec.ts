import { test, expect } from "@playwright/test";
import { mountView, waitForStableBox } from "./harness";

// Proof spec for the browser view-harness: the overlay window boots against a
// fully mocked backend and shows the reset-countdown popup (2026-07-28) on
// hover - a separate bubble above the existing %/safe% info circle, near
// (<1h) coloured amber. NOT testing the hot (<5m) bucket here: fmtResetDisplay
// rounds to the nearest wall-clock 10-minute mark, so a fixed small offset can
// round into or out of the 5-minute hot threshold depending on the real
// second/minute the test happens to run at - genuinely flaky without a
// mockable clock, verified manually instead (see session notes).
test.describe("view-harness / overlay reset popup", () => {
  test("hovering a dial reveals the reset-countdown popup, near state in amber", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    const now = Date.now();
    await mountView(page, {
      entry: "overlay",
      invoke: {
        list_accounts: [
          {
            id: "acc1", label: "Fleet-3", colour: "#57b894", icon: "robot",
            config_dir: "", chrome_profile_dir: "", email: "", org_uuid: "",
            subscription_tier: "", created_at: "", fleet_eligible: false,
          },
        ],
        get_usage_map: {
          acc1: {
            captured_at: new Date(now).toISOString(),
            // 20m out: comfortably inside the near (<1h) bucket even after
            // fmtResetDisplay's up-to-10-minute rounding either direction.
            five_hour: { utilization: 97, resets_at: new Date(now + 20 * 60_000).toISOString() },
            // Near the top of the 7d window - widest realistic countdown
            // text ("163h Xm"), to exercise the popup's worst-case width for
            // the horizontal containment check below.
            seven_day: { utilization: 55, resets_at: new Date(now + 6 * 24 * 3_600_000 + 20 * 3_600_000).toISOString() },
          },
        },
      },
    });

    const cell = page.locator(".oc-cell[data-acc-id='acc1']");
    await expect(cell).toBeAttached();
    await cell.hover();

    const popup = cell.locator(".oc-reset-pop");
    await expect(popup).toBeVisible();
    await expect(popup).toContainText("5h");
    await expect(popup).toContainText("7d");

    // Near state (<1h to reset): the 5h countdown renders amber per the
    // shared resetUrgency thresholds (RESET_NEAR_MS, formatters.ts).
    const nearSpan = popup.locator(".oc-reset-rel.oc-reset-near");
    await expect(nearSpan).toBeAttached();

    await page.screenshot({ path: "test-results/overlay-reset-popup-live.png" });

    await waitForStableBox(page, ".oc-cell[data-acc-id='acc1'] .oc-reset-pop");

    // The real overlay window is sized to #ocPanel's own bounding box
    // (overlay-drag.ts's resizeOverlayToContent) - a plain browser tab has no
    // such limit, so the only way this harness can catch "popup renders
    // outside the box the real window would be sized to" is by comparing
    // rects directly. This is a single-account row, so this dial is both the
    // first AND last in the row - the exact worst case for the popup's
    // centred left/right overhang (see overlay.css's padding-left/right).
    const panelBox = await page.locator("#ocPanel").boundingBox();
    const popupBox = await popup.boundingBox();
    expect(panelBox).not.toBeNull();
    expect(popupBox).not.toBeNull();
    // .oc-reset-pop centers via left:50%+translateX(-50%) (overlay.css): odd/even
    // pixel-width parity between popup and panel can still leave a sub-pixel
    // rounding residue even with fonts settled - tolerate under 1px of it.
    const SUBPIXEL_TOLERANCE = 1;
    expect(popupBox!.y).toBeGreaterThanOrEqual(panelBox!.y);
    expect(popupBox!.x).toBeGreaterThanOrEqual(panelBox!.x - SUBPIXEL_TOLERANCE);
    expect(popupBox!.x + popupBox!.width).toBeLessThanOrEqual(
      panelBox!.x + panelBox!.width + SUBPIXEL_TOLERANCE,
    );

    const unmocked = errors.filter((e) => e.includes("unmocked command"));
    expect(unmocked, `unmocked commands:\n${unmocked.join("\n")}`).toEqual([]);
  });
});
