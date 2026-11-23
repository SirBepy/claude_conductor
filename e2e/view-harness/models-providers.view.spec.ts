import { test, expect, type Page } from "@playwright/test";
import { capture, invokeCalls, mountView } from "./harness";

// asserts: src/views/settings/subviews/models-providers/models-providers.ts, src/views/settings/subviews/models-providers/provider-modals.ts, src/views/settings/subviews/models-providers/role-sheet.ts, src/views/settings/subviews/models-providers/role-cards.ts, src/views/settings/subviews/models-providers/account-rows.ts, src/views/settings/subviews/models-providers/keyed-list.ts, src/views/settings/subviews/models-providers/models-providers.css

// Settings > Models & providers in the browser harness: the account list, the
// "Who does what" tabs and cards, the role sheet and the Add account modal.

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

async function mount(page: Page, routing: unknown = ROUTING, accounts: unknown[] = [SUB, CREDIT, KIMI, DEEPSEEK]): Promise<void> {
  await page.setViewportSize({ width: 1100, height: 900 });
  await mountView(page, {
    view: "settings-models-providers",
    invoke: {
      list_accounts: accounts,
      list_projects: PROJECTS,
      get_settings: { theme: "void", routing },
      save_settings: null,
      add_endpoint_account: {},
      remove_account: null,
    },
  });
  await page.locator(".view-settings-models-providers .mp-card").first().waitFor();
}

const card = (page: Page, kind: string, group = "personal") => page.locator(`.mp-card[data-group="${group}"][data-kind="${kind}"]`);

async function savedRule(page: Page, kind: string, group = "personal"): Promise<Record<string, unknown> | undefined> {
  const calls = (await invokeCalls(page)).filter((c) => c.cmd === "save_settings");
  const last = calls[calls.length - 1];
  const routing = (last?.args as { updated: { routing: { groups: Record<string, Record<string, Record<string, unknown>>> } } }).updated.routing;
  return routing.groups[group]?.[kind];
}

test.describe("view-harness / Models & providers", () => {
  test("lists every account with its badge and the Codex row as a promise", async ({ page }) => {
    await mount(page);
    const rows = page.locator(".mp-acc-rows .acc-row");
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0).locator(".mp-badge")).toHaveText("Subscription");
    await expect(rows.nth(1).locator(".mp-badge")).toHaveText("API credit");
    await expect(rows.nth(2).locator(".mp-badge")).toHaveText("Membership");
    await expect(rows.nth(3).locator(".mp-badge")).toHaveText("Pay per token");
    await expect(rows.nth(3)).toContainText("api.deepseek.com");
    await expect(page.locator(".mp-later")).toContainText("coming later");
    await capture(page, "mp-page-personal");
  });

  test("tabs switch the payment group, with the projects that use it", async ({ page }) => {
    await mount(page);
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

  test("a kind with no rule says Default, a kind with one shows its account, model and limit line", async ({ page }) => {
    await mount(page);
    await expect(card(page, "research")).toContainText("Default");
    await expect(card(page, "research")).toContainText("No rule set");
    await expect(card(page, "build")).toContainText("deepseek-v4-pro");
    await expect(card(page, "build")).toContainText("DeepSeek");
    await expect(card(page, "build")).toContainText("At its limit: wait");
    await expect(card(page, "plan")).toContainText("flexible");
    await expect(card(page, "plan").locator(".mp-pips i.f")).toHaveCount(4);
  });

  test("the sheet opens on a card, saves each change to Settings.routing and Done closes it", async ({ page }) => {
    await mount(page);
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
    await mount(page);
    await card(page, "plan").click();
    await expect(page.locator("#mp-sheet")).toHaveClass(/\bopen\b/);
    await page.keyboard.press("Escape");
    await expect(page.locator("#mp-sheet")).not.toHaveClass(/\bopen\b/);
  });

  test("changing the account re-lists its models and drops a model it does not serve", async ({ page }) => {
    await mount(page);
    await card(page, "plan").click();
    await expect(page.locator("#sh-model option")).toHaveText(["Default model", "Haiku", "Sonnet", "Opus", "Fable"]);
    await page.locator("#sh-acc").selectOption("acct-kimi");
    await expect(page.locator("#sh-model option")).toHaveText(["Default model", "k3.1-pro", "kimi-for-coding", "Other model id..."]);
    await expect(page.locator("#sh-model")).toHaveValue("");
    await expect.poll(() => savedRule(page, "plan")).toMatchObject({ account_id: "acct-kimi" });
    const saved = await savedRule(page, "plan");
    expect(saved).not.toHaveProperty("model");
    expect(saved).not.toHaveProperty("range");
  });

  test("Other model id on an Endpoint account saves the typed id and refuses a bad one", async ({ page }) => {
    await mount(page);
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
    await mount(page);
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
    await mount(page);
    await card(page, "build").click();
    await page.locator("#mp-sh-reset").click();
    await expect.poll(() => savedRule(page, "build")).toBeUndefined();
    await page.locator("#mp-sh-done").click();
    await expect(card(page, "build")).toContainText("No rule set");
  });

  test("hovering a card, a row or a tab leaves every box where it was", async ({ page }) => {
    await mount(page);
    const boxes = async (): Promise<unknown[]> => page.evaluate(() => {
      const sel = ".mp-card, .acc-row, .mp-tab, .mp-chip, .mp-ind";
      // Hovering a row scrolls it into view; positions are measured in scroller space so only a reflow shows.
      const scrolled = document.querySelector(".mp-page .view-body")!.scrollTop;
      return Array.from(document.querySelectorAll(sel)).map((e) => {
        const r = e.getBoundingClientRect();
        return [Math.round(r.x * 10), Math.round((r.y + scrolled) * 10), Math.round(r.width * 10), Math.round(r.height * 10)];
      });
    });
    // Let the view's own entrance settle and bring the card on screen first, so only hover can move a box.
    await card(page, "build").scrollIntoViewIfNeeded();
    await page.waitForTimeout(700);
    const before = await boxes();
    await card(page, "build").hover();
    await page.waitForTimeout(250);
    const during = await boxes();
    await page.locator(".mp-acc-rows .acc-row").first().hover();
    await page.locator("#mp-tab-client").hover();
    await page.waitForTimeout(250);
    const after = await boxes();
    // The card's chevron nudges by transform only; no box moves.
    expect(during).toEqual(before);
    expect(after).toEqual(before);
  });

  test("the sheet, the tab panels and the folds declare transitions", async ({ page }) => {
    await mount(page);
    const props = async (sel: string): Promise<string> => page.locator(sel).first().evaluate((e) => getComputedStyle(e).transitionProperty);
    expect(await props("#mp-sheet")).toContain("transform");
    expect(await props(".mp-panel")).toContain("opacity");
    expect(await props(".mp-card")).toContain("border-color");
    expect(await props(".mp-li")).toContain("grid-template-rows");
    await card(page, "review").click();
    expect(await props("#sh-fold")).toContain("grid-template-rows");
  });

  test("Add account > Kimi Code posts the preset's URL, auth style and models with the typed key", async ({ page }) => {
    await mount(page, ROUTING, [SUB]);
    await page.locator("#mp-add-btn").click();
    await expect(page.locator(".mp-modal")).toBeVisible();
    await expect(page.locator(".mpm-save")).toHaveText("Sign in and add");
    await page.locator("#mpm-provider").selectOption("kimi_code");
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

  test("Custom endpoint asks for the URL, auth style and model ids", async ({ page }) => {
    await mount(page, ROUTING, [SUB]);
    await page.locator("#mp-add-btn").click();
    await page.locator("#mpm-provider").selectOption("custom");
    await expect(page.locator("#mpm-custom")).toHaveClass(/\bon\b/);
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

  test("Claude subscription in the modal hands off to the sign-in wizard", async ({ page }) => {
    await mount(page, ROUTING, [SUB]);
    await page.locator("#mp-add-btn").click();
    await page.locator(".mpm-save").click();
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

// Records the real-speed clip Joe reviews (tab switch, open sheet, change model, close).
// Off unless MP_CLIP=1: the video lands in test-results/.
// `use({ video })` is only legal at the top level of the file.
if (process.env["MP_CLIP"]) test.use({ video: { mode: "on", size: { width: 1100, height: 900 } } });
test.describe("view-harness / Models & providers clip", () => {
  test.skip(!process.env["MP_CLIP"], "set MP_CLIP=1 to record");

  test("tab switch, open sheet, change model, close", async ({ page }) => {
    await mount(page);
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
    await page.locator("#mp-add-btn").click();
    await page.waitForTimeout(900);
    await page.locator("#mpm-provider").selectOption("custom");
    await page.waitForTimeout(900);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
  });
});
