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
});
