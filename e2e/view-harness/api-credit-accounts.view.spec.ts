import { test, expect, type Page } from "@playwright/test";
import { invokeCalls, mountView, SESSIONS_BASE_INVOKE } from "./harness";

// asserts: src/views/settings/subviews/accounts/accounts.ts, src/views/dashboard/dashboard.ts, src/shared/change-account-modal.ts, src/views/sessions/account-picker-logic.ts

// The API-credit account kind in the browser harness: Settings row, dashboard
// meter, and the draft chat's account picker (chip shown, never preselected).

const SUB = {
  id: "acct-sub", label: "Personal", colour: "#8b5cf6", icon: "user", config_dir: "", chrome_profile_dir: "",
  email: "joe@example.com", org_uuid: "org-1", subscription_tier: "claude_max", created_at: "2026-01-01T00:00:00Z",
  fleet_eligible: false, kind: "subscription",
};
const CREDIT = {
  id: "acct-credit", label: "API credit", colour: "#10b981", icon: "user", config_dir: "", chrome_profile_dir: "",
  email: "joe@example.com", org_uuid: "console-org", subscription_tier: "", created_at: "2026-10-26T00:00:00Z",
  fleet_eligible: false, kind: "api_credit",
};
const STATUS = {
  account_id: "acct-credit",
  max_grant_remaining_cents: 17871, max_grant_total_cents: 20000, max_grant_expires_at: "2026-11-02T00:00:00Z",
  purchased_remaining_cents: 0, spend_cents: 2128, limit_cents: 20000, spend_resets_at: "2026-11-01T00:00:00Z",
  fetched_at: "2026-10-26T12:00:00Z", blocked: false, block_reason: null, error: null,
};

const PROJECT = {
  id: "proj1", path: "C:/repo", name: "repo", parent_segment: null,
  avatar: { kind: "none" }, automation_enabled: false, tokens_7d: 0, live: 0,
  any_automated: false, last_active_at: null, path_exists: true,
  worktrees: [], last_worktree_path: null, last_start_folder_rel: null,
};

async function openDraft(page: Page, accounts: unknown[]): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [], get_active_sessions: [],
      list_project_groups: [PROJECT], list_projects: [], list_accounts: accounts,
      resolve_project_account: null, project_last_activity_at: 0, count_ai_todos: 0,
      list_claude_md_scopes: [{ rel_path: "", label: "Repo root", nested: false }],
      get_history: [],
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
    },
  });
  await page.locator("#viewMoreBtn").waitFor();
  await page.keyboard.press("Control+n");
  await page.locator(".project-picker-row").click();
  await page.locator("#session-pane .session-composer .composer-textarea").waitFor();
}

test.describe("view-harness / API-credit accounts", () => {
  test("Settings row shows the live figures and offers Connect Console, not Reauth or Set as default", async ({ page }) => {
    await mountView(page, {
      view: "settings-accounts",
      invoke: {
        list_accounts: [SUB, CREDIT],
        get_settings: { theme: "void", default_account_id: "acct-sub" },
        get_account_identity: { oauthAccount: null, tokenExpiresAt: null, refreshTokenExpiresAt: null, hasCookie: false, drift: false, driftMessage: null },
        get_auth_state_map: {},
        get_terminal_identity: null,
        list_api_keys: [],
        get_api_credit_status: { "acct-credit": STATUS },
      },
    });

    const row = page.locator('.acc-row[data-id="acct-credit"]');
    await expect(row.locator(".acc-credit")).toContainText("API credit $178.71 of $200 left, expires Nov 2 · $21.28 of $200 limit");
    await expect(row.locator(".account-icon-badge .ph-key")).toHaveCount(1);
    await expect(row.locator(".acc-menu-connect-console")).toHaveCount(1);
    await expect(row.locator(".acc-menu-reauth, .acc-menu-default, .acc-menu-add-cookie")).toHaveCount(0);
    await expect(row.locator(".acc-linked")).toHaveText("Linked to Personal");
    await expect(page.locator("#acc-add-credit-btn")).toHaveCount(0);
    await expect(page.locator("#acc-add-btn")).toBeVisible();
  });

  test("Add account asks which kind first, then continues into the API-credit form", async ({ page }) => {
    await mountView(page, {
      view: "settings-accounts",
      invoke: {
        list_accounts: [SUB],
        get_settings: { theme: "void" },
        get_auth_state_map: {},
        get_account_identity: { oauthAccount: null, tokenExpiresAt: null, refreshTokenExpiresAt: null, hasCookie: false, drift: false, driftMessage: null },
        get_terminal_identity: null,
        list_api_keys: [],
        get_api_credit_status: {},
      },
    });
    await expect(page.locator("#acc-add-btn")).toHaveCount(1);
    await page.locator("#acc-add-btn").click();
    const card = page.locator(".aac-kind-card");
    await expect(card).toBeVisible();
    await expect(card.locator(".aac-kind-choice")).toHaveCount(2);
    await expect(card.locator('[data-kind="subscription"]')).toContainText("Claude plan");
    await expect(card.locator('[data-kind="api_credit"]')).toContainText("API credit");
    await card.locator('[data-kind="api_credit"]').click();
    await expect(page.locator("#aacm-label")).toBeVisible();
    await expect(page.locator("#aacm-key")).toBeVisible();
  });

  test("Add account > Claude plan continues into the existing wizard", async ({ page }) => {
    await mountView(page, {
      view: "settings-accounts",
      invoke: {
        list_accounts: [SUB],
        get_settings: { theme: "void" },
        get_auth_state_map: {},
        get_account_identity: { oauthAccount: null, tokenExpiresAt: null, refreshTokenExpiresAt: null, hasCookie: false, drift: false, driftMessage: null },
        get_terminal_identity: null,
        list_api_keys: [],
        get_api_credit_status: {},
      },
    });
    await page.locator("#acc-add-btn").click();
    await page.locator('.aac-kind-card [data-kind="subscription"]').click();
    await expect(page.locator("#aaw-name")).toBeVisible();
    await expect(page.locator(".aac-kind-card")).toHaveCount(0);
  });

  test("Settings row names a missing Console login and offers the fix inline", async ({ page }) => {
    await mountView(page, {
      view: "settings-accounts",
      invoke: {
        list_accounts: [CREDIT],
        get_settings: { theme: "void" },
        get_auth_state_map: {},
        get_terminal_identity: null,
        list_api_keys: [],
        get_api_credit_status: {
          "acct-credit": {
            ...STATUS, max_grant_remaining_cents: null, max_grant_total_cents: null, max_grant_expires_at: null,
            spend_cents: null, limit_cents: null, error: "Console not connected",
          },
        },
      },
    });
    const row = page.locator('.acc-row[data-id="acct-credit"]');
    await expect(row).toContainText("Console not connected");
    await expect(row.locator(".acc-credit-connect")).toBeVisible();
  });

  test("Replace API key opens a masked key field and sends the pasted key for that account", async ({ page }) => {
    await mountView(page, {
      view: "settings-accounts",
      invoke: {
        list_accounts: [CREDIT],
        get_settings: { theme: "void" },
        get_auth_state_map: {},
        get_terminal_identity: null,
        list_api_keys: [],
        get_api_credit_status: { "acct-credit": STATUS },
        replace_api_credit_key: null,
        refresh_api_credit_status: STATUS,
      },
    });
    const row = page.locator('.acc-row[data-id="acct-credit"]');
    await row.locator(".acc-btn-kebab").click();
    await row.locator(".acc-menu-replace-key").click();

    const field = page.locator("#rapk-key");
    await expect(field).toBeVisible();
    await expect(field).toHaveAttribute("type", "password");
    const save = page.locator(".rapk-save-btn");
    await expect(save).toBeDisabled();
    await field.fill("  sk-ant-dummy-new ");
    await save.click();

    await expect(field).toHaveCount(0);
    const calls = await invokeCalls(page);
    expect(calls.find((c) => c.cmd === "replace_api_credit_key")?.args).toEqual({
      accountId: "acct-credit",
      apiKey: "sk-ant-dummy-new",
    });
  });

  test("Replace API key keeps the field open and shows the reason when the key is refused", async ({ page }) => {
    // replace_api_credit_key is deliberately unmocked: the harness rejects it.
    await mountView(page, {
      view: "settings-accounts",
      invoke: {
        list_accounts: [CREDIT],
        get_settings: { theme: "void" },
        get_auth_state_map: {},
        get_terminal_identity: null,
        list_api_keys: [],
        get_api_credit_status: { "acct-credit": STATUS },
      },
    });
    const row = page.locator('.acc-row[data-id="acct-credit"]');
    await row.locator(".acc-btn-kebab").click();
    await row.locator(".acc-menu-replace-key").click();
    await page.locator("#rapk-key").fill("sk-ant-bad");
    await page.locator(".rapk-save-btn").click();
    await expect(page.locator(".aikm-error")).toBeVisible();
    await expect(page.locator("#rapk-key")).toBeVisible();
  });

  test("dashboard keeps the credit account out of the plan cards and draws its meter line", async ({ page }) => {
    await mountView(page, {
      view: "dashboard",
      invoke: {
        get_accounts_setup_prompt_state: { shouldShow: false },
        list_accounts: [SUB, CREDIT],
        get_usage_map: {},
        get_auth_state_map: {},
        get_skill_usage_week: { entries: [], total_sessions: 0 },
        list_instances: [],
        poll_now: null,
        get_api_credit_status: { "acct-credit": STATUS },
      },
    });
    await expect(page.locator('.dash-acard[data-acc-id="acct-sub"]')).toBeVisible();
    await expect(page.locator('.dash-acard[data-acc-id="acct-credit"]')).toHaveCount(0);
    await expect(page.locator('.dash-credit[data-acc-id="acct-credit"]')).toContainText("$178.71 left");
    await expect(page.locator('.dash-credit[data-acc-id="acct-credit"] .dash-credit-name')).toHaveText("API credit · Personal");
  });

  test("draft account picker lists the API-credit chip unselected beside the auto-picked subscription", async ({ page }) => {
    await openDraft(page, [SUB, CREDIT]);
    await expect(page.locator("#session-pane .sb-account")).toHaveAttribute("aria-label", "Personal");
    await page.locator("#session-pane .sb-account-btn").click();
    const overlay = page.locator(".cam-modal-card");
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('.account-chip[data-acc-id="acct-sub"].sel')).toHaveCount(1);
    await expect(overlay.locator('.account-chip[data-acc-id="acct-credit"]')).toHaveCount(1);
    await expect(overlay.locator('.account-chip[data-acc-id="acct-credit"]')).toHaveAttribute("title", "API credit · Personal");
    await expect(overlay.locator('.account-chip[data-acc-id="acct-credit"].sel')).toHaveCount(0);
  });

  test("a lone API-credit account is never preselected: the first send asks for an account", async ({ page }) => {
    await openDraft(page, [CREDIT]);
    const ta = page.locator("#session-pane .session-composer .composer-textarea");
    await ta.fill("hello");
    await ta.press("Enter");
    await expect(page.getByText("Pick an account for this chat first")).toBeVisible();
    const overlay = page.locator(".cam-modal-card");
    await expect(overlay).toBeVisible();
    // The sole API-credit account is never auto-picked, so the picker opens
    // with it as a pickable chip rather than the static one-account display.
    await expect(overlay.locator('[data-acc-id="acct-credit"]')).toContainText("API credit");
  });
});
