import { test, expect } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE } from "./harness";

// Frontend half of the mobile account-sharing fix (ai_todo 241). The daemon
// route + allowlist are covered by Rust tests; THIS proves the consuming
// behavior: the new-chat modal's "Start session" button is gated on
// list_accounts returning accounts. On mobile the command was unrouted -> []
// -> button stuck disabled (the reported bug). With the route added it returns
// accounts -> button enables. The harness feeds list_accounts exactly as the
// daemon now would, so this exercises the real modal DOM + gating logic.

// Commands the default view (dashboard) + the new-chat modal fire. list_accounts
// is overridden per-test below.
const BASE_INVOKE = { ...SESSIONS_BASE_INVOKE, list_instances: [] };

const FAKE_ACCOUNT = { id: "acc1", label: "Test Account", icon: "user", colour: "#8b5cf6" };

async function openModal(page: import("@playwright/test").Page): Promise<void> {
  // Call (don't await) the DEV-gated seam - the returned Promise only resolves
  // when the modal closes, so awaiting it here would hang.
  await page.evaluate(() => {
    (window as unknown as { __openNewChatModal: () => void }).__openNewChatModal();
  });
}

test.describe("view-harness / new-chat account picker", () => {
  test("Start session ENABLES when accounts are listed (the fix)", async ({ page }) => {
    await mountView(page, { invoke: { ...BASE_INVOKE, list_accounts: [FAKE_ACCOUNT] } });
    await openModal(page);

    const overlay = page.locator(".model-effort-modal-card");
    await expect(overlay).toBeVisible();

    // The account resolved (sole account) -> not the empty state, chip shown.
    await expect(overlay.locator(".me-acc-empty")).toHaveCount(0);
    await expect(overlay.locator(".account-chip").first()).toContainText("Test Account");

    // Start session is enabled.
    await expect(overlay.locator(".me-confirm")).toBeEnabled();
  });

  test("Start session STAYS DISABLED with no accounts (the bug it fixes)", async ({ page }) => {
    await mountView(page, { invoke: { ...BASE_INVOKE, list_accounts: [] } });
    await openModal(page);

    const overlay = page.locator(".model-effort-modal-card");
    await expect(overlay).toBeVisible();

    // This is exactly what mobile saw when list_accounts was unrouted.
    await expect(overlay.locator(".me-acc-empty")).toContainText("No Claude accounts yet");
    await expect(overlay.locator(".me-confirm")).toBeDisabled();
  });
});
