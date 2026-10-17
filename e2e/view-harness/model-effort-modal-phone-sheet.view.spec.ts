// asserts: src/views/sessions/model-effort-modal.css
import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE } from "./harness";

// Phone: dock the model/effort modal to the bottom, same as the project
// picker already does (project-picker-phone-sheet.view.spec.ts).
// Before this change the two were visibly inconsistent in the same new-chat
// chain: a bottom sheet to pick a project, then a centred dialog right after
// it to pick the model.

const PHONE = { width: 393, height: 852 };

const BASE_INVOKE = { ...SESSIONS_BASE_INVOKE, list_instances: [], list_accounts: [] };

async function openModal(page: Page): Promise<void> {
  await mountView(page, { invoke: BASE_INVOKE });
  // Fire-and-forget: the __openNewChatModal seam's promise only resolves once
  // the modal closes.
  await page.evaluate(() => {
    (window as unknown as { __openNewChatModal: () => void }).__openNewChatModal();
  });
  await page.waitForSelector(".model-effort-modal-card");
}

test.describe("view-harness / model-effort modal phone bottom sheet", () => {
  test("phone: card docks flush to the bottom edge, full width, rounded top corners only", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openModal(page);

    const card = page.locator(".model-effort-modal-card");
    const box = (await card.boundingBox())!;

    expect(box.x).toBe(0);
    expect(box.width).toBe(PHONE.width);
    expect(Math.round(box.y + box.height)).toBe(PHONE.height);

    const radius = await card.evaluate((el) => getComputedStyle(el).borderRadius);
    // Centred desktop box is a uniform 10px radius (base rule) - the phone
    // sheet must be rounded on top only, square on the bottom.
    expect(radius).not.toBe("10px");
  });

  test("desktop: card stays centred, unchanged", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openModal(page);

    const card = page.locator(".model-effort-modal-card");
    const box = (await card.boundingBox())!;

    expect(box.y).toBeGreaterThan(40);
    expect(box.y + box.height).toBeLessThan(800 - 40);
    expect(box.x).toBeGreaterThan(40);
    expect(box.x + box.width).toBeLessThan(1280 - 40);

    const radius = await card.evaluate((el) => getComputedStyle(el).borderRadius);
    expect(radius).toBe("10px");
  });
});
