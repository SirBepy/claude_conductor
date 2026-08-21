import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE } from "./harness";

// Todo 418: .oc-reset-pop opens ABOVE its dial. The overlay window reserves
// 78px of headroom for it (overlay.css:75); the phone header has none.

const PHONE = { width: 393, height: 852 };

const BASE_INVOKE = {
  ...SESSIONS_BASE_INVOKE,
  list_instances: [],
  get_active_sessions: [],
  load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
};

const ACCOUNT = {
  id: "acc-1", label: "Work", colour: "#e67e22", icon: "briefcase",
  config_dir: "", chrome_profile_dir: "", email: "", org_uuid: "",
  subscription_tier: "max", created_at: "2026-01-01T00:00:00Z",
};

// Near-reset state: both windows resetting soon, so resetPopupHtml renders
// both rows (see shared/usage-dial.ts's resetPopupRow - "" when no active reset).
function usageSnapshot(now: number) {
  return {
    captured_at: new Date(now).toISOString(),
    five_hour: { utilization: 0.82, resets_at: new Date(now + 30 * 60_000).toISOString() },
    seven_day: { utilization: 0.55, resets_at: new Date(now + 2 * 3_600_000).toISOString() },
  };
}

async function mountHeaderWithDials(page: Page): Promise<void> {
  await page.setViewportSize(PHONE);
  const now = Date.now();
  await mountView(page, {
    view: "sessions",
    invoke: { ...BASE_INVOKE, list_accounts: [ACCOUNT], get_usage_map: { "acc-1": usageSnapshot(now) } },
  });
  await page.locator(".view-sessions .view-header").waitFor();
  // usage-dials.ts only self-mounts when isRemote() (window.__TAURI__ absent),
  // which the harness's fake Tauri global deliberately isn't - drive the
  // module directly instead of faking a whole transport swap.
  await page.evaluate(async () => {
    const { mountUsageDials } = await import("/views/sessions/usage-dials.ts");
    const host = document.querySelector<HTMLElement>("#usage-dial-host")!;
    mountUsageDials(host);
  });
  await page.locator(".oc-cell").first().waitFor();
}

test.describe("view-harness / usage dial reset popup in the phone header", () => {
  test("compact dial cell suppresses the reset popup - no clip off the top", async ({ page }) => {
    await mountHeaderWithDials(page);

    await page.locator(".oc-cell").first().hover();
    // usage-dials.ts renders cellHtml(..., compact: true) - the popup that
    // clips off the top of the header (todo 418) never enters the DOM here.
    await expect(page.locator(".oc-reset-pop")).toHaveCount(0);
  });
});
