import { expect, test } from "@playwright/test";
import path from "node:path";
import { mountView } from "./harness";
import { shotDir } from "./shot-dir";

// asserts: src/styles/settings-sections.css, src/views/settings/subviews/about/about.ts
// Every Settings subpage shares one 45px row, and every field, dropdown and
// button on it is 32px, inside a row or not (Add account, Copy link, Pair, the
// Data page's Clear all). The index keeps the kit's compact 36px nav rows.

const SUBPAGES = [
  "settings-appearance", "settings-notifications", "settings-chat-defaults",
  "settings-characters", "settings-usage-meter", "settings-voice", "settings-browser",
  "settings-power", "settings-shortcuts", "settings-data", "settings-permissions",
  "settings-about", "settings-remote-access", "settings-accounts",
];

const ACCT = {
  id: "acct-sub", label: "Personal", colour: "#8b5cf6", icon: "user", config_dir: "", chrome_profile_dir: "",
  email: "joe@example.com", org_uuid: "org-1", subscription_tier: "claude_max", created_at: "2026-01-01T00:00:00Z",
  fleet_eligible: false, kind: "subscription",
};
const dataset = (id: string, label: string) => ({
  dataset: id, label, record_count: 1234, oldest_entry: 1750000000, newest_entry: 1760000000,
  retention: "90d", total_db_bytes: 4_500_000,
});
// Enough data that each page renders its real rows instead of an empty state.
const INVOKE = {
  list_accounts: [ACCT],
  get_account_identity: { oauthAccount: null, tokenExpiresAt: null, refreshTokenExpiresAt: null, hasCookie: false, drift: false, driftMessage: null },
  get_auth_state_map: {},
  get_terminal_identity: null,
  list_api_keys: [],
  get_api_credit_status: {},
  get_app_version: "0.2.137",
  get_storage_info: [dataset("UsageSnapshots", "Usage History"), dataset("TokenRecords", "Token Records")],
  piper_status: { installed: true, voices: [] },
  list_audio_output_devices: [{ name: "Speakers", is_default: true }],
  get_gaming_mode: { on: false, paused_sessions: 0, stopped_procs: 0, stopped_containers: 0, docker_desktop_stopped: false },
  get_default_whitelist: [],
  list_characters: [],
  remote_access_status: { enabled: true },
  remote_access_qr: { svg: "<svg width='80' height='80'></svg>", url: "http://x/pair", iroh: null },
  list_remote_devices: [{ id: "d1", name: "Pixel 8", created_at: 1760000000, last_used: 1760100000, kind: "phone" }],
  list_machines: { self: { machine_id: "m0", label: "Desktop", os: "windows" }, peers: [] },
  list_auto_accept: [],
  list_wrap_up_on_done: [],
  get_settings_load_notice: null,
};

const SHOT_DIR = shotDir();

for (const view of SUBPAGES) {
  test(`${view}: rows are 45px and their controls 32px`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 1400 });
    await mountView(page, { view, invoke: INVOKE });
    await page.locator(`.view-${view}`).waitFor();
    // Pages fill in after their own fetches resolve.
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(SHOT_DIR, `row-heights-${view}.png`), fullPage: true });

    const rows = await page.locator(".kit-row").evaluateAll((els) =>
      els
        .filter((el) => el.getBoundingClientRect().height > 0)
        .map((el) => ({
          label: (el.querySelector(".kit-row-label")?.textContent ?? el.textContent ?? "").trim().slice(0, 40),
          h: Math.round(el.getBoundingClientRect().height),
        })),
    );
    for (const r of rows) expect(r.h, `row "${r.label}"`).toBe(45);

    // Fields, dropdowns and text buttons; color swatches (28px), sliders and
    // icon-only buttons have their own sizes.
    const controls = await page
      .locator(".kit-row select, .kit-row input[type=text], .kit-row input[type=number], .kit-row input[type=time], .kit-row .btn-danger, .btn-secondary, .ra-token-field")
      .evaluateAll((els) =>
        els
          .filter((el) => el.getBoundingClientRect().height > 0)
          .map((el) => ({
            what: `${el.tagName.toLowerCase()} ${(el.textContent ?? "").trim().slice(0, 30) || (el as HTMLInputElement).placeholder || el.className}`,
            h: Math.round(el.getBoundingClientRect().height),
          })),
      );
    for (const c of controls) expect(c.h, c.what).toBe(32);
  });
}

test("settings index keeps the compact 36px nav rows", async ({ page }) => {
  await mountView(page, { view: "settings", invoke: INVOKE });
  await page.locator(".kit-nav-row").first().waitFor();
  const heights = await page.locator(".kit-nav-row").evaluateAll((els) =>
    els.map((el) => Math.round(el.getBoundingClientRect().height)),
  );
  expect(heights.length).toBeGreaterThan(5);
  for (const h of heights) expect(h).toBe(36);
});
