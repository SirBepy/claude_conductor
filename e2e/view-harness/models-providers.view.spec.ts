// Reviewed 2026-11-25: rewritten for the merged Accounts & models page (route settings-accounts, Accounts and Who does what tabs, one section per company with its own Add, the Endpoint rows' provider figures and counted tokens); the old Models & providers page it asserted is gone.
import { test, expect, type Page } from "@playwright/test";
import { capture, fireEvent, invokeCalls, mountView } from "./harness";

// asserts: src/views/settings/subviews/models-providers/models-providers.ts, src/views/settings/subviews/models-providers/provider-modals.ts, src/views/settings/subviews/models-providers/role-sheet.ts, src/views/settings/subviews/models-providers/role-cards.ts, src/views/settings/subviews/models-providers/account-rows.ts, src/views/settings/subviews/models-providers/provider-usage-rows.ts, src/views/settings/subviews/models-providers/who-does-what.ts, src/views/settings/subviews/models-providers/keyed-list.ts, src/views/settings/subviews/models-providers/models-providers.css, src/views/settings/subviews/accounts/accounts.ts, src/views/settings/subviews/accounts/company-sections.ts, src/shared/provider-usage-format.ts, src/shared/provider-usage-watch.ts

// Settings > Accounts & models in the browser harness: the Accounts tab (one
// section per company, billing chips, Add, each Endpoint row's figures) and the
// "Who does what" tab (role cards, the role sheet).

const SUB = {
  id: "acct-sub", label: "Claude personal", colour: "#d97757", icon: "sparkle", config_dir: "", chrome_profile_dir: "",
  email: "joe@example.com", org_uuid: "org-1", subscription_tier: "claude_max", created_at: "2026-01-01T00:00:00Z",
  fleet_eligible: false, kind: "subscription",
};
const CREDIT = {
  id: "acct-credit", label: "API credit", colour: "#10b981", icon: "key", config_dir: "", chrome_profile_dir: "",
  email: "joe@example.com", org_uuid: "console-org", subscription_tier: "", created_at: "2026-10-26T00:00:00Z",
  fleet_eligible: false, kind: "api_credit",
};
const endpoint = (id: string, label: string, preset: string, base_url: string, models: string[]) => ({
  id, label, colour: "#4ea1ff", icon: "key", config_dir: "", chrome_profile_dir: "", email: "", org_uuid: "",
  subscription_tier: "", created_at: "2026-11-23T00:00:00Z", fleet_eligible: false, kind: "endpoint",
  endpoint: { preset, base_url, auth_style: "bearer", models },
});
const KIMI = endpoint("acct-kimi", "Kimi Code", "kimi_code", "https://api.kimi.ai/coding/", ["k3.1-pro", "kimi-for-coding"]);
const DEEPSEEK = endpoint("acct-ds", "DeepSeek", "deepseek", "https://api.deepseek.com/anthropic", ["deepseek-v4-pro", "deepseek-flash"]);
const OPENROUTER = endpoint("acct-or", "OpenRouter", "openrouter", "https://openrouter.ai/api", []);

const PROJECTS = [
  { id: "p1", path: "C:/a", name: "claude_usage_in_taskbar", payment_group: "personal" },
  { id: "p2", path: "C:/b", name: "save-christmas" },
  { id: "p3", path: "C:/c", name: "zng-app", payment_group: "client" },
];

const ROUTING = {
  groups: {
    personal: {
      build: { account_id: "acct-ds", model: "deepseek-v4-pro", effort: "high", fallback: { kind: "wait" } },
      plan: { account_id: "acct-sub", model: "opus", effort: "xhigh", range: { min_model: "sonnet", max_model: "opus" } },
    },
    client: {},
  },
};

const sums = (input: number, output: number) => ({ input, output, cache_read: 0, cache_creation: 0, turns: 3 });
const NO_TOKENS = sums(0, 0);
const tokens = (id: string, week: number) => ({
  account_id: id, five_hour: sums(week / 4, week / 4), today: sums(week / 4, week / 4), seven_day: sums(week / 2, week / 2),
});
const usage = (id: string, source: string, over: Record<string, unknown> = {}) => ({
  account_id: id, fetched_at: new Date().toISOString(), windows: [], balances: [], spend: null, available: null, error: null, source, ...over,
});
const inHours = (h: number): string => new Date(Date.now() + h * 3_600_000).toISOString();

const NO_FIGURES = { usage: {}, tokens: {} };

async function mount(
  page: Page,
  routing: unknown = ROUTING,
  accounts: unknown[] = [SUB, CREDIT, KIMI, DEEPSEEK],
  providerUsage: unknown = NO_FIGURES,
): Promise<void> {
  await page.setViewportSize({ width: 1100, height: 900 });
  await mountView(page, {
    view: "settings-accounts",
    invoke: {
      list_accounts: accounts,
      list_projects: PROJECTS,
      get_settings: { theme: "void", routing, default_account_id: "acct-sub" },
      save_settings: null,
      add_endpoint_account: {},
      remove_account: null,
      get_account_identity: { oauthAccount: null, tokenExpiresAt: null, refreshTokenExpiresAt: null, hasCookie: false, drift: false, driftMessage: null },
      get_auth_state_map: {},
      get_terminal_identity: null,
      get_api_credit_status: {},
      get_provider_usage: providerUsage,
    },
  });
  await page.locator(".view-settings-models-providers .acm-prov").first().waitFor();
}

/** Mounts the page and opens its Who does what tab. */
async function mountWho(page: Page, routing: unknown = ROUTING, accounts: unknown[] = [SUB, CREDIT, KIMI, DEEPSEEK]): Promise<void> {
  await mount(page, routing, accounts);
  await page.locator("#acm-tab-who").click();
  await page.locator(".view-settings-models-providers .mp-card").first().waitFor();
}

const card = (page: Page, kind: string, group = "personal") => page.locator(`.mp-card[data-group="${group}"][data-kind="${kind}"]`);
const company = (page: Page, id: string) => page.locator(`.acm-prov[data-company="${id}"]`);
const usageSlot = (page: Page, id: string) => page.locator(`.mp-usage[data-usage-for="${id}"]`);

async function savedRule(page: Page, kind: string, group = "personal"): Promise<Record<string, unknown> | undefined> {
  const calls = (await invokeCalls(page)).filter((c) => c.cmd === "save_settings");
  const last = calls[calls.length - 1];
  const routing = (last?.args as { updated: { routing: { groups: Record<string, Record<string, Record<string, unknown>>> } } }).updated.routing;
  return routing.groups[group]?.[kind];
}

test.describe("view-harness / Accounts & models", () => {
  test("the Accounts tab groups every account under its company with its billing chip, and Codex stays a promise", async ({ page }) => {
    await mount(page);
    await expect(page.locator("#acm-tab-accounts")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#acm-cnt-accounts")).toHaveText("4");
    await expect(page.locator(".view-header .icon-btn[aria-label*='nfo']")).toHaveCount(0);

    const anthropic = company(page, "anthropic").locator(".acc-row:not(.acc-terminal-row)");
    await expect(anthropic).toHaveCount(2);
    await expect(anthropic.nth(0).locator(".mp-badge")).toHaveText("Subscription");
    await expect(anthropic.nth(1).locator(".mp-badge")).toHaveText("Included credit");
    await expect(company(page, "kimi_code").locator(".acc-row .mp-badge")).toHaveText("Subscription");
    await expect(company(page, "deepseek").locator(".acc-row .mp-badge")).toHaveText("Pay per token");
    await expect(company(page, "deepseek").locator(".acc-row")).toContainText("api.deepseek.com");
    // A company with no account draws the dashed Add row instead of a row.
    await expect(company(page, "openrouter").locator(".acc-row")).toHaveCount(0);
    await expect(company(page, "openrouter").locator('.acm-add-row[data-add="openrouter"]')).toBeVisible();
    await expect(page.locator(".acm-legend-row .mp-badge")).toHaveText(["Subscription", "Included credit", "Pay per token"]);
    await expect(page.locator(".mp-later")).toContainText("coming later");
    await capture(page, "mp-page-accounts");
  });

  test("the tabs switch between the account list and the routing rules, and Who does what loads on first open", async ({ page }) => {
    await mount(page);
    await expect(page.locator("#acm-panel-accounts")).toBeVisible();
    await expect(page.locator("#acm-panel-who")).toBeHidden();
    await expect(page.locator(".mp-card")).toHaveCount(0);
    await page.locator("#acm-tab-who").click();
    await expect(page.locator("#acm-tab-who")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#acm-panel-who")).toBeVisible();
    await expect(page.locator("#acm-panel-accounts")).toBeHidden();
    await expect(page.locator(".mp-card").first()).toBeVisible();
    await page.locator("#acm-tab-accounts").click();
    await expect(page.locator("#acm-panel-accounts")).toBeVisible();
    await expect(page.locator("#acm-panel-who")).toBeHidden();
  });

  test("payment-group tabs switch the group, with the projects that use it", async ({ page }) => {
    await mountWho(page);
    await expect(page.locator("#mp-proj-personal .mp-chip")).toHaveText(["claude_usage_in_taskbar", "save-christmas"]);
    await expect(page.locator("#mp-cnt-personal")).toHaveText("2");
    await expect(page.locator("#mp-tab-personal")).toHaveAttribute("aria-selected", "true");
    await page.locator("#mp-tab-client").click();
    await expect(page.locator("#mp-tab-client")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#mp-panel-client")).toHaveClass(/\bon\b/);
    await expect(page.locator("#mp-panel-personal")).not.toHaveClass(/\bon\b/);
    await expect(page.locator("#mp-proj-client .mp-chip")).toHaveText(["zng-app"]);
    await page.waitForTimeout(400);
    await capture(page, "mp-page-client");
  });

  test("a kind with no rule says Default and names the default account, a kind with one shows its account, model and chips", async ({ page }) => {
    await mountWho(page);
    await expect(card(page, "research")).toHaveClass(/\bis-default\b/);
    // A job with no rule runs on its main chat's account at the tier default; a chat kind on Settings' default account.
    await expect(card(page, "research")).toContainText("Default · its main chat's account");
    await expect(card(page, "research").locator(".mp-lvl")).toHaveText("2/4");
    await expect(card(page, "main_chat")).toHaveClass(/\bis-default\b/);
    await expect(card(page, "main_chat")).toContainText("Default · Claude personal");
    await expect(card(page, "build")).toContainText("deepseek-v4-pro");
    await expect(card(page, "build")).toContainText("DeepSeek");
    await expect(card(page, "build").locator(".mp-then")).toHaveText("Waits at limit");
    await expect(card(page, "plan")).toContainText("Opus");
    await expect(card(page, "plan").locator(".mp-lvl")).toHaveText("3/4");
    await expect(card(page, "plan").locator(".mp-then")).toHaveText("Main chat can adjust");
    await expect(card(page, "plan").locator(".mp-pips i.f")).toHaveCount(4);
  });

  test("the sheet opens on a card, saves each change to Settings.routing and Done closes it", async ({ page }) => {
    await mountWho(page);
    await card(page, "build").click();
    const sheet = page.locator("#mp-sheet");
    await expect(sheet).toHaveClass(/\bopen\b/);
    await expect(page.locator("#mp-sh-title")).toHaveText("Build");
    await expect(page.locator("#sh-acc")).toHaveValue("acct-ds");
    await expect(page.locator("#sh-model")).toHaveValue("deepseek-v4-pro");
    await page.locator("#sh-model").selectOption("deepseek-flash");
    await expect.poll(() => savedRule(page, "build")).toMatchObject({ account_id: "acct-ds", model: "deepseek-flash", effort: "high", fallback: { kind: "wait" } });
    await page.locator("#sh-eff").selectOption("low");
    await expect.poll(() => savedRule(page, "build")).toMatchObject({ model: "deepseek-flash", effort: "low" });
    await page.waitForTimeout(450);
    await capture(page, "mp-sheet-build");
    await page.locator("#mp-sh-done").click();
    await expect(sheet).not.toHaveClass(/\bopen\b/);
    await expect(card(page, "build")).toContainText("deepseek-flash");
  });

  test("Escape closes the sheet", async ({ page }) => {
    await mountWho(page);
    await card(page, "plan").click();
    await expect(page.locator("#mp-sheet")).toHaveClass(/\bopen\b/);
    await page.keyboard.press("Escape");
    await expect(page.locator("#mp-sheet")).not.toHaveClass(/\bopen\b/);
  });

  test("changing the account re-lists its models and drops a model it does not serve", async ({ page }) => {
    await mountWho(page);
    await card(page, "plan").click();
    await expect(page.locator("#sh-model option")).toHaveText(["Default model", "Haiku (level 1 of 4)", "Sonnet (level 2 of 4)", "Opus (level 3 of 4)", "Fable (level 4 of 4)"]);
    await page.locator("#sh-acc").selectOption("acct-kimi");
    await expect(page.locator("#sh-model option")).toHaveText(["Default model", "k3.1-pro", "kimi-for-coding", "Other model id..."]);
    await expect(page.locator("#sh-model")).toHaveValue("");
    await expect.poll(() => savedRule(page, "plan")).toMatchObject({ account_id: "acct-kimi" });
    const saved = await savedRule(page, "plan");
    expect(saved).not.toHaveProperty("model");
    expect(saved).not.toHaveProperty("range");
  });

  test("Other model id on an Endpoint account saves the typed id and refuses a bad one", async ({ page }) => {
    await mountWho(page);
    await card(page, "build").click();
    await page.locator("#sh-model").selectOption("__other__");
    await expect(page.locator("#sh-other-fold")).toHaveClass(/\bon\b/);
    await page.locator("#sh-model-other").fill("-bad");
    await page.locator("#sh-model-other").blur();
    await expect(page.locator("#sh-model-error")).toBeVisible();
    await page.locator("#sh-model-other").fill("my/model:7b");
    await page.locator("#sh-model-other").blur();
    await expect.poll(() => savedRule(page, "build")).toMatchObject({ model: "my/model:7b" });
    await expect(page.locator("#sh-model-error")).toBeHidden();
  });

  test("the raise-or-lower switch is only on jobs and writes a range", async ({ page }) => {
    await mountWho(page);
    await card(page, "main_chat").click();
    await expect(page.locator("#sh-flex")).toHaveCount(0);
    await page.locator("#mp-sh-back").click();
    await card(page, "review").click();
    await expect(page.locator("#sh-flex")).not.toBeChecked();
    await page.locator("#sh-flex").evaluate((el: HTMLInputElement) => { el.click(); });
    await expect(page.locator("#sh-fold")).toHaveClass(/\bon\b/);
    await expect.poll(() => savedRule(page, "review")).toMatchObject({ range: { min_model: "haiku", max_model: "fable", min_effort: "low", max_effort: "max" } });
    await page.locator("#sh-mnM").selectOption("sonnet");
    await expect.poll(() => savedRule(page, "review")).toMatchObject({ range: { min_model: "sonnet", max_model: "fable" } });
  });

  test("Reset to default removes the rule", async ({ page }) => {
    await mountWho(page);
    await card(page, "build").click();
    await page.locator("#mp-sh-reset").click();
    await expect.poll(() => savedRule(page, "build")).toBeUndefined();
    await page.locator("#mp-sh-done").click();
    await expect(card(page, "build")).toHaveClass(/\bis-default\b/);
    await expect(card(page, "build")).toContainText("Default · its main chat's account");
  });

  test("hovering an account row, an Add button or a tab leaves every box where it was", async ({ page }) => {
    await mount(page);
    const boxes = async (): Promise<unknown[]> => page.evaluate(() => {
      const sel = ".acc-row, .acm-prov-head, .acm-add, .acm-add-row, .acm-tab, .mp-ind";
      // Hovering a row scrolls it into view; positions are measured in scroller space so only a reflow shows.
      const scrolled = document.querySelector(".mp-page .view-body")!.scrollTop;
      return Array.from(document.querySelectorAll(sel)).map((e) => {
        const r = e.getBoundingClientRect();
        return [Math.round(r.x * 10), Math.round((r.y + scrolled) * 10), Math.round(r.width * 10), Math.round(r.height * 10)];
      });
    });
    // Let the view's own entrance settle first, so only hover can move a box.
    await page.waitForTimeout(700);
    const before = await boxes();
    await page.locator(".acc-row").first().hover();
    await page.waitForTimeout(250);
    const during = await boxes();
    await page.locator(".acm-add").first().hover();
    await page.locator("#acm-tab-who").hover();
    await page.waitForTimeout(250);
    const after = await boxes();
    expect(during).toEqual(before);
    expect(after).toEqual(before);
  });

  test("hovering a role card or a payment-group tab leaves every box where it was", async ({ page }) => {
    await mountWho(page);
    const boxes = async (): Promise<unknown[]> => page.evaluate(() => {
      const sel = ".mp-card, .mp-tab, .mp-chip, .mp-ind";
      const scrolled = document.querySelector(".mp-page .view-body")!.scrollTop;
      return Array.from(document.querySelectorAll(sel)).map((e) => {
        const r = e.getBoundingClientRect();
        return [Math.round(r.x * 10), Math.round((r.y + scrolled) * 10), Math.round(r.width * 10), Math.round(r.height * 10)];
      });
    });
    await card(page, "build").scrollIntoViewIfNeeded();
    await page.waitForTimeout(700);
    const before = await boxes();
    await card(page, "build").hover();
    await page.waitForTimeout(250);
    const during = await boxes();
    await page.locator("#mp-tab-client").hover();
    await page.waitForTimeout(250);
    const after = await boxes();
    // The card's chevron nudges by transform only; no box moves.
    expect(during).toEqual(before);
    expect(after).toEqual(before);
  });

  test("the sheet, the tab panels, the account rows and the folds declare transitions", async ({ page }) => {
    await mountWho(page);
    const props = async (sel: string): Promise<string> => page.locator(sel).first().evaluate((e) => getComputedStyle(e).transitionProperty);
    expect(await props("#mp-sheet")).toContain("transform");
    expect(await props(".mp-panel")).toContain("opacity");
    expect(await props(".mp-card")).toContain("border-color");
    expect(await props(".acc-row")).toContain("border-color");
    await card(page, "review").click();
    expect(await props("#sh-fold")).toContain("grid-template-rows");
  });

  test("Add Kimi Code in its own section posts the preset's URL, auth style and models with the typed key", async ({ page }) => {
    await mount(page, ROUTING, [SUB]);
    await page.locator('.acm-add-row[data-add="kimi_code"]').click();
    await expect(page.locator(".mp-modal")).toBeVisible();
    await expect(page.locator(".mp-modal .modal-header")).toContainText("Add Kimi Code");
    await expect(page.locator("#mpm-provider")).toHaveCount(0);
    await expect(page.locator("#mpm-bill .mp-badge")).toHaveText("Subscription");
    await expect(page.locator(".mpm-save")).toHaveText("Add account");
    await expect(page.locator("#mpm-label")).toHaveValue("Kimi Code");
    await expect(page.locator(".mpm-save")).toBeDisabled();
    await expect(page.locator("#mpm-key")).toHaveAttribute("type", "password");
    await page.locator("#mpm-key").fill("dummy-endpoint-key");
    await expect(page.locator(".mpm-save")).toBeEnabled();
    await page.waitForTimeout(450);
    await capture(page.locator(".mp-modal"), "mp-modal-kimi");
    await page.locator(".mpm-save").click();
    await expect.poll(async () => (await invokeCalls(page)).some((c) => c.cmd === "add_endpoint_account")).toBe(true);
    const call = (await invokeCalls(page)).find((c) => c.cmd === "add_endpoint_account");
    expect(call?.args).toEqual({
      label: "Kimi Code", preset: "kimi_code", baseUrl: "https://api.kimi.ai/coding/", authStyle: "bearer",
      models: ["k3.1-pro", "kimi-for-coding"], apiKey: "dummy-endpoint-key",
    });
  });

  test("a company that already has an account adds another from its header button", async ({ page }) => {
    await mount(page);
    await expect(company(page, "deepseek").locator('.acm-add-row')).toHaveCount(0);
    await company(page, "deepseek").locator('.acm-add[data-add="deepseek"]').click();
    await expect(page.locator(".mp-modal .modal-header")).toContainText("Add DeepSeek");
    await expect(page.locator("#mpm-bill .mp-badge")).toHaveText("Pay per token");
    await expect(page.locator("#mpm-label")).toHaveValue("DeepSeek");
  });

  test("Custom endpoint asks for the URL, auth style and model ids", async ({ page }) => {
    await mount(page, ROUTING, [SUB]);
    await page.locator('.acm-add-row[data-add="custom"]').click();
    await expect(page.locator("#mpm-url")).toBeVisible();
    await page.locator("#mpm-label").fill("Local proxy");
    await page.locator("#mpm-key").fill("k");
    await expect(page.locator(".mpm-save")).toBeDisabled();
    await page.locator("#mpm-url").fill("http://localhost:4000/anthropic");
    await page.locator("#mpm-auth").selectOption("x_api_key");
    await page.locator("#mpm-models").fill("big, small, big");
    await expect(page.locator(".mpm-save")).toBeEnabled();
    await page.locator(".mpm-save").click();
    await expect.poll(async () => (await invokeCalls(page)).some((c) => c.cmd === "add_endpoint_account")).toBe(true);
    const call = (await invokeCalls(page)).find((c) => c.cmd === "add_endpoint_account");
    expect(call?.args).toEqual({
      label: "Local proxy", preset: "custom", baseUrl: "http://localhost:4000/anthropic", authStyle: "x_api_key",
      models: ["big", "small"], apiKey: "k",
    });
  });

  test("Add account in the Anthropic section asks which kind first and hands the plan to the sign-in wizard", async ({ page }) => {
    await mount(page, ROUTING, [SUB]);
    await company(page, "anthropic").locator('.acm-add[data-add="anthropic"]').click();
    await expect(page.locator(".aac-kind-card .aac-kind-choice")).toHaveCount(2);
    await page.locator('.aac-kind-card [data-kind="subscription"]').click();
    await expect(page.locator("#aaw-name")).toBeVisible();
  });

  test("an endpoint row's menu edits, replaces the key and removes", async ({ page }) => {
    await mount(page);
    const row = page.locator('.acc-row[data-id="acct-ds"]');
    await row.locator(".acc-btn-kebab").click();
    await expect(row.locator(".menu-item")).toHaveText([/Edit/, /Replace API key/, /Remove/]);
    await row.locator('[data-act="remove"]').click();
    await page.locator(".app-confirm-ok").click();
    await expect.poll(async () => (await invokeCalls(page)).some((c) => c.cmd === "remove_account")).toBe(true);
    expect((await invokeCalls(page)).find((c) => c.cmd === "remove_account")?.args).toEqual({ accountId: "acct-ds" });
  });
});

test.describe("view-harness / Accounts & models: provider figures", () => {
  test("an Endpoint row shows what its provider says is left and the tokens Conductor counted, a plan row shows neither", async ({ page }) => {
    await mount(page, ROUTING, [SUB, CREDIT, KIMI, DEEPSEEK], {
      usage: {
        "acct-ds": usage("acct-ds", "deepseek", { balances: [{ currency: "USD", amount: 12.4 }], available: true }),
        "acct-kimi": usage("acct-kimi", "kimi_code", { windows: [{ label: "5h", used_pct: 42, resets_at: inHours(2) }] }),
      },
      tokens: { "acct-ds": tokens("acct-ds", 1_800_000), "acct-kimi": { account_id: "acct-kimi", five_hour: NO_TOKENS, today: NO_TOKENS, seven_day: NO_TOKENS } },
    });
    const ds = usageSlot(page, "acct-ds");
    await expect(ds.locator(".mp-usage-fig")).toHaveText("$12.40 left");
    await expect(ds.locator(".mp-usage-fig")).toHaveClass(/\bis-ok\b/);
    await expect(ds.locator(".mp-usage-tok")).toHaveText("1.8M tokens via Conductor this week");
    await expect(ds.locator(".mp-usage-tok")).toHaveAttribute("title", /Usage outside Conductor is not included/);
    await expect(ds.locator(".mp-usage-pill")).toHaveCount(0);
    const kimi = usageSlot(page, "acct-kimi");
    await expect(kimi.locator(".mp-usage-fig")).toContainText("5h 42%");
    await expect(kimi.locator(".mp-usage-fig")).toContainText("resets in");
    // Nothing counted on Kimi: no tokens line, never "0 tokens".
    await expect(kimi.locator(".mp-usage-tok")).toHaveCount(0);
    await expect(usageSlot(page, "acct-sub")).toHaveCount(0);
    await expect(usageSlot(page, "acct-credit")).toHaveCount(0);
    await capture(company(page, "deepseek"), "mp-usage-deepseek-row");
  });

  test("an Endpoint account the daemon has no figures for reads Usage unknown, never a limit or 0", async ({ page }) => {
    await mount(page, ROUTING, [SUB, OPENROUTER, DEEPSEEK], {
      usage: { "acct-ds": usage("acct-ds", "deepseek", { error: "HTTP 401 from the provider" }) },
      tokens: {},
    });
    const or = usageSlot(page, "acct-or");
    await expect(or.locator(".mp-usage-fig")).toHaveText("Usage unknown");
    await expect(or.locator(".mp-usage-fig")).toHaveClass(/\bis-unknown\b/);
    await expect(or.locator(".mp-usage-pill")).toHaveCount(0);
    const ds = usageSlot(page, "acct-ds");
    await expect(ds.locator(".mp-usage-fig")).toHaveText("Usage unknown");
    // The provider's reason is a tooltip only: it is never drawn as a figure or a limit.
    await expect(ds.locator(".mp-usage-fig")).toHaveAttribute("title", "HTTP 401 from the provider");
    await expect(ds.locator(".mp-usage-fig")).not.toHaveClass(/\bis-limit\b/);
  });

  test("an empty balance is flagged Out of balance in the limit tone", async ({ page }) => {
    await mount(page, ROUTING, [SUB, DEEPSEEK], {
      usage: { "acct-ds": usage("acct-ds", "deepseek", { balances: [{ currency: "USD", amount: 0 }], available: false }) },
      tokens: {},
    });
    const ds = usageSlot(page, "acct-ds");
    await expect(ds.locator(".mp-usage-fig")).toHaveClass(/\bis-limit\b/);
    await expect(ds.locator(".mp-usage-pill")).toHaveText("Out of balance");
  });

  test("a provider-usage-changed event repaints that row's figures in place without rebuilding the row", async ({ page }) => {
    await mount(page, ROUTING, [SUB, DEEPSEEK], {
      usage: { "acct-ds": usage("acct-ds", "deepseek", { balances: [{ currency: "USD", amount: 12.4 }], available: true }) },
      tokens: {},
    });
    const slot = usageSlot(page, "acct-ds");
    await expect(slot.locator(".mp-usage-fig")).toHaveText("$12.40 left");
    // An open menu proves the row itself is not rebuilt by a figures change.
    const row = page.locator('.acc-row[data-id="acct-ds"]');
    await row.locator(".acc-btn-kebab").click();
    await expect(row.locator(".menu-popover")).not.toHaveClass(/\bhidden\b/);
    await fireEvent(page, "provider-usage-changed", [
      { account_id: "acct-ds", usage: usage("acct-ds", "deepseek", { balances: [{ currency: "USD", amount: 3 }], available: true }) },
    ]);
    await expect(slot.locator(".mp-usage-fig")).toHaveText("$3.00 left");
    await expect(row.locator(".menu-popover")).not.toHaveClass(/\bhidden\b/);
  });

  test("a Claude-only setup never asks the daemon for provider figures", async ({ page }) => {
    await mount(page, ROUTING, [SUB, CREDIT]);
    await page.waitForTimeout(300);
    expect((await invokeCalls(page)).some((c) => c.cmd === "get_provider_usage")).toBe(false);
  });
});

// Records the real-speed clip Joe reviews (tab switch, open sheet, change model, close).
// Off unless MP_CLIP=1: the video lands in test-results/.
// `use({ video })` is only legal at the top level of the file.
if (process.env["MP_CLIP"]) test.use({ video: { mode: "on", size: { width: 1100, height: 900 } } });
test.describe("view-harness / Accounts & models clip", () => {
  test.skip(!process.env["MP_CLIP"], "set MP_CLIP=1 to record");

  test("tab switch, open sheet, change model, close", async ({ page }) => {
    await mountWho(page);
    await page.waitForTimeout(800);
    await card(page, "build").scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.locator("#mp-tab-client").click();
    await page.waitForTimeout(900);
    await page.locator("#mp-tab-personal").click();
    await page.waitForTimeout(900);
    await card(page, "build").click();
    await page.waitForTimeout(1000);
    await page.locator("#sh-model").selectOption("deepseek-flash");
    await page.waitForTimeout(800);
    await page.locator("#mp-sh-done").click();
    await page.waitForTimeout(1000);
    await page.locator("#acm-tab-accounts").click();
    await page.waitForTimeout(900);
    await page.locator('.acm-add[data-add="deepseek"]').click();
    await page.waitForTimeout(900);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
  });
});
