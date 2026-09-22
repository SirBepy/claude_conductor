import { test, expect } from "@playwright/test";
import { mountView, invokeCalls } from "./harness";

// Proof spec for the browser view-harness: the SPA boots the DESKTOP dashboard
// against a fully mocked backend, no Tauri process, no daemon.
test.describe("view-harness / dashboard", () => {
  test("boots the desktop shell (no phone pairing gate)", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    // The dashboard view's own commands (grep src/views/dashboard for api.*).
    // Boot commands are seeded automatically by the harness; these are additive.
    await mountView(page, {
      view: "dashboard",
      invoke: {
        get_accounts_setup_prompt_state: { shouldShow: false },
        list_accounts: [],
        get_usage_map: {},
        get_auth_state_map: {},
        get_skill_usage_week: { entries: [], total_sessions: 0 },
        list_instances: [],
        poll_now: null,
      },
    });

    // Desktop shell rendered: the side menu exists (phone gate would replace the
    // whole page with a token form instead).
    await expect(page.locator("#sidemenu")).toBeAttached();

    // isTauri() path taken -> desktop, not remote/phone.
    const isTauri = await page.evaluate(() => !!window.__TAURI__);
    expect(isTauri).toBe(true);

    // Boot actually talked to the (mocked) backend.
    const calls = await invokeCalls(page);
    const cmds = calls.map((c) => c.cmd);
    expect(cmds).toContain("get_settings");

    // No unmocked-command rejections leaked to the console during boot. If this
    // fails, the boot seed in harness.ts needs the newly-called command added.
    const unmocked = errors.filter((e) => e.includes("unmocked command"));
    expect(unmocked, `unmocked commands during boot:\n${unmocked.join("\n")}`).toEqual([]);
  });

  // 9965c966: get_auth_state_map feeds a "Needs login" badge onto the affected
  // account's card only - a healthy sibling account must stay clean.
  test("shows the needs-login badge on the affected account only", async ({ page }) => {
    await mountView(page, {
      view: "dashboard",
      invoke: {
        get_accounts_setup_prompt_state: { shouldShow: false },
        list_accounts: [
          { id: "acc-healthy", label: "Healthy", icon: "user", colour: "#8b5cf6" },
          { id: "acc-expired", label: "Expired", icon: "user", colour: "#f59e0b" },
        ],
        get_usage_map: {},
        get_auth_state_map: { "acc-expired": "needslogin" },
        get_skill_usage_week: { entries: [], total_sessions: 0 },
        list_instances: [],
        poll_now: null,
      },
    });

    const healthyCard = page.locator('.dash-acard[data-acc-id="acc-healthy"]');
    const expiredCard = page.locator('.dash-acard[data-acc-id="acc-expired"]');
    await expect(expiredCard.locator(".dash-acard-warning")).toContainText("Needs login");
    await expect(healthyCard.locator(".dash-acard-warning")).toHaveCount(0);
  });

  // P1-4: account cards are `role="button" tabindex="0"`, not native buttons,
  // so Tab-focus + Enter must select them the same as a click does.
  test("keyboard: Tab-focusing an account card and pressing Enter selects it", async ({ page }) => {
    await mountView(page, {
      view: "dashboard",
      invoke: {
        get_accounts_setup_prompt_state: { shouldShow: false },
        list_accounts: [
          { id: "acc-1", label: "One", icon: "user", colour: "#8b5cf6" },
          { id: "acc-2", label: "Two", icon: "user", colour: "#f59e0b" },
        ],
        get_usage_map: {},
        get_auth_state_map: {},
        get_skill_usage_week: { entries: [], total_sessions: 0 },
        list_instances: [],
        poll_now: null,
      },
    });

    const first = page.locator('.dash-acard[data-acc-id="acc-1"]');
    const second = page.locator('.dash-acard[data-acc-id="acc-2"]');
    // No default_account_id in settings -> the first registered account wins.
    await expect(first).toHaveClass(/active/);

    await second.focus();
    await expect(second).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(second).toHaveClass(/active/);
    await expect(first).not.toHaveClass(/active/);
  });

  // P0-1: the ring's unit ("5h"/"7d") used to live only in a hover title
  // attribute - it must also render as visible text.
  test("ring columns show a visible 5h/7d unit label", async ({ page }) => {
    // get_usage_map returns raw UsageSnapshot rows (api.ts's own
    // usageSnapshotMapToRecordMap converts them) - not flat session_pct
    // fields, which silently produce a null (empty-ring) record instead.
    const future2h = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const future48h = new Date(Date.now() + 48 * 3_600_000).toISOString();
    await mountView(page, {
      view: "dashboard",
      invoke: {
        get_accounts_setup_prompt_state: { shouldShow: false },
        list_accounts: [{ id: "acc-1", label: "One", icon: "user", colour: "#8b5cf6" }],
        get_usage_map: {
          "acc-1": {
            captured_at: new Date().toISOString(),
            five_hour: { utilization: 40, resets_at: future2h },
            seven_day: { utilization: 20, resets_at: future48h },
          },
        },
        get_auth_state_map: {},
        get_skill_usage_week: { entries: [], total_sessions: 0 },
        list_instances: [],
        poll_now: null,
      },
    });

    const labels = page.locator('.dash-acard[data-acc-id="acc-1"] .dash-ring-label');
    await expect(labels).toHaveCount(2);
    await expect(labels.nth(0)).toBeVisible();
    await expect(labels.nth(0)).toHaveText("5h");
    await expect(labels.nth(1)).toHaveText("7d");
  });

  // P0-2: listAccounts/getUsageMap/getAuthStateMap self-catch in shared/api.ts
  // and never reach fullRefresh's own catch - the genuinely reachable
  // failure is the crossover auto-poll's pollNow() call, which does not.
  test("shows a dismissible banner when an automatic poll fails", async ({ page }) => {
    const pastIso = new Date(Date.now() - 3_600_000).toISOString();
    await mountView(page, {
      view: "dashboard",
      invoke: {
        get_accounts_setup_prompt_state: { shouldShow: false },
        list_accounts: [],
        get_usage_map: {},
        get_auth_state_map: {},
        get_skill_usage_week: { entries: [], total_sessions: 0 },
        list_instances: [],
        // Session window already expired -> the crossover auto-poll fires
        // immediately on mount instead of waiting for the real interval.
        get_history: [
          {
            captured_at: pastIso,
            five_hour: { utilization: 50, resets_at: pastIso },
            seven_day: { utilization: 30, resets_at: pastIso },
          },
        ],
        // poll_now intentionally unmocked: the harness rejects an unmocked
        // command, simulating a real (non-self-catching) poll failure.
      },
    });

    const banner = page.locator("#dashRefreshErrorBanner");
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute("aria-live", "polite");
    await expect(banner).toContainText("Couldn't refresh");

    await page.locator("#dashRefreshErrorDismiss").click();
    await expect(banner).toHaveCount(0);
  });
});
