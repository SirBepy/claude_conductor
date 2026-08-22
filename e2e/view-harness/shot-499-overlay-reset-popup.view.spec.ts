import { test, expect, type Page } from "@playwright/test";
import { capture, mountView } from "./harness";

// Todo 499: commit 9997c531 widened .oc-dial-row's left/right padding from 65px
// to 78px so the reset popup stops overhanging. Mount + containment check are
// lifted from overlay.view.spec.ts; the two captures are what it lacks.

const ACCOUNT = {
  id: "acc1", label: "Fleet-3", colour: "#57b894", icon: "robot",
  config_dir: "", chrome_profile_dir: "", email: "", org_uuid: "",
  subscription_tier: "", created_at: "", fleet_eligible: false,
};

/** Inlined, not added to harness.ts (other agents own that file): the popup
 *  fades/scales over 200ms, so a box read mid-transition is too narrow. */
async function waitForStableBox(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    return new Promise<void>((resolve) => {
      const el = document.querySelector(sel) as HTMLElement;
      let last = el.getBoundingClientRect().width;
      let stable = 0;
      function check() {
        const cur = el.getBoundingClientRect().width;
        if (Math.abs(cur - last) < 0.01) {
          stable++;
          if (stable >= 3) return resolve();
        } else {
          stable = 0;
        }
        last = cur;
        requestAnimationFrame(check);
      }
      requestAnimationFrame(check);
    });
  }, selector);
}

test.describe("@shot", () => {
  test.skip(!process.env.CC_SHOTS, "capture-only, run it with CC_SHOTS=1");

  test("reset popup open on hover, and the dial row at rest", async ({ page }) => {
    const now = Date.now();
    await mountView(page, {
      entry: "overlay",
      invoke: {
        list_accounts: [ACCOUNT],
        get_usage_map: {
          acc1: {
            captured_at: new Date(now).toISOString(),
            five_hour: { utilization: 97, resets_at: new Date(now + 20 * 60_000).toISOString() },
            // Worst-case popup width: the widest realistic 7d countdown text.
            seven_day: {
              utilization: 55,
              resets_at: new Date(now + 6 * 24 * 3_600_000 + 20 * 3_600_000).toISOString(),
            },
          },
        },
      },
    });

    const row = page.locator(".oc-dial-row");
    const cell = page.locator(".oc-cell[data-acc-id='acc1']");
    await expect(cell).toBeAttached();
    await expect(row).toBeVisible();

    // At rest first: this is the state todo 417 questions, where the reserved
    // popup headroom reads as empty space.
    // The popup is always in the DOM, gated on opacity by :hover, so
    // toBeHidden() would never hold - read the computed value instead.
    await expect
      .poll(() => page.locator(".oc-reset-pop").first().evaluate((el) => getComputedStyle(el).opacity))
      .toBe("0");
    await capture(row, "overlay-reset-popup-at-rest");

    // Todo 417 round 2: the headroom was 70px of dead space over a 62px dial.
    const panelAtRest = (await page.locator("#ocPanel").boundingBox())!;
    const dialAtRest = (await page.locator(".oc-dial").boundingBox())!;
    const headroom = dialAtRest.y - panelAtRest.y;
    console.log(`[417] at-rest headroom above the dial: ${headroom}px`);
    expect(headroom).toBeLessThanOrEqual(45);

    await cell.hover();
    const popup = cell.locator(".oc-reset-pop");
    await expect(popup).toBeVisible();
    await expect(popup).toContainText("5h");
    await expect(popup).toContainText("7d");
    await waitForStableBox(page, ".oc-cell[data-acc-id='acc1'] .oc-reset-pop");

    const panelBox = await page.locator("#ocPanel").boundingBox();
    const popupBox = await popup.boundingBox();
    expect(panelBox).not.toBeNull();
    expect(popupBox).not.toBeNull();
    const SUBPIXEL_TOLERANCE = 1;
    expect(popupBox!.y).toBeGreaterThanOrEqual(panelBox!.y);
    expect(popupBox!.x).toBeGreaterThanOrEqual(panelBox!.x - SUBPIXEL_TOLERANCE);
    expect(popupBox!.x + popupBox!.width).toBeLessThanOrEqual(
      panelBox!.x + panelBox!.width + SUBPIXEL_TOLERANCE,
    );

    // Reclaiming the headroom moved the popup down over the info circle's
    // empty top cap - it must still stop short of the account name.
    const nameBox = (await cell.locator(".oc-info-nm").boundingBox())!;
    expect(popupBox!.y + popupBox!.height).toBeLessThanOrEqual(nameBox.y);

    await capture(row, "overlay-reset-popup-open");
  });
});
