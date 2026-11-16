// asserts: src/shared/change-account-modal.ts, src/shared/change-account-modal.css, src/shared/account-chip.ts, src/shared/account-limit-status.ts
import { test, expect, type Locator, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE } from "./harness";

// The "B trimmed" Change account picker: flat rows under small section labels,
// the account's own icon badge on the left, a dial on the right, no status text
// at rest except a limited account's red flag, and the figures as inline text
// on hover or keyboard focus (never a popover).

const acc = (id: string, label: string, colour: string, icon: string, kind: "subscription" | "api_credit") => ({
  id, label, colour, icon, config_dir: "", chrome_profile_dir: "",
  email: "joe@example.com", org_uuid: "org-1", subscription_tier: kind === "api_credit" ? "" : "claude_max",
  created_at: "2026-01-01T00:00:00Z", fleet_eligible: false, kind,
});
const PERSONAL = acc("acct-personal", "Personal", "#8b5cf6", "user", "subscription");
const WORK = acc("acct-work", "Work", "#f5a623", "briefcase", "subscription");
const CREDIT = acc("acct-credit", "API credit", "#10b981", "user", "api_credit");
const SPARE = acc("acct-spare", "Spare key", "#3b82f6", "user", "api_credit");

const credit = (id: string, remaining: number) => ({
  account_id: id,
  max_grant_remaining_cents: remaining, max_grant_total_cents: 20000, max_grant_expires_at: "2026-11-30T00:00:00Z",
  purchased_remaining_cents: 0, spend_cents: 20000 - remaining, limit_cents: 20000, spend_resets_at: "2026-12-01T00:00:00Z",
  fetched_at: "2026-11-16T12:00:00Z", blocked: false, block_reason: null, error: null,
});

const PROJECT = {
  id: "proj1", path: "C:/repo", name: "repo", parent_segment: null,
  avatar: { kind: "none" }, tokens_7d: 0, live: 0,
  any_automated: false, last_active_at: null, path_exists: true,
  worktrees: [], last_worktree_path: null, last_start_folder_rel: null,
};

const hoursAhead = (h: number): string => new Date(Date.now() + h * 3_600_000).toISOString();
const usage = (id: string, session: number, weekly: number) => ({
  account_id: id, captured_at: new Date().toISOString(),
  five_hour: { utilization: session, resets_at: hoursAhead(0.9) },
  seven_day: { utilization: weekly, resets_at: hoursAhead(90) },
});

async function openPicker(page: Page): Promise<Locator> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [], get_active_sessions: [],
      list_project_groups: [PROJECT], list_projects: [], list_accounts: [PERSONAL, WORK, CREDIT, SPARE],
      resolve_project_account: null, project_last_activity_at: 0, count_ai_todos: 0,
      list_claude_md_scopes: [{ rel_path: "", label: "Repo root", nested: false }],
      get_settings: { theme: "void", default_account_id: "acct-personal" },
      get_history: [],
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
      get_usage_map: { "acct-personal": usage("acct-personal", 20, 49), "acct-work": usage("acct-work", 100, 62) },
      // The spare key has no figure: an unknown balance.
      get_api_credit_status: { "acct-credit": credit("acct-credit", 17427) },
    },
  });
  await page.locator(".view-sessions .view-header").waitFor();
  await page.keyboard.press("Control+n");
  await page.locator(".project-picker-row").click();
  await page.locator("#session-pane .session-composer .composer-textarea").waitFor();
  await page.locator("#session-pane .sb-account-btn").click();
  const card = page.locator(".cam-modal-card");
  await expect(card).toBeVisible();
  await expect(card.locator(".cam-limit")).toHaveCount(4);
  return card;
}

const opacity = (l: Locator) => l.evaluate((el) => getComputedStyle(el).opacity);
// The figures fade in over 0.12s, so a read straight after hover can see a partial value.
const settledOpacity = async (l: Locator, want: string) => {
  await expect.poll(() => opacity(l)).toBe(want);
};

test.describe("view-harness / Change account picker (B trimmed)", () => {
  test("rows sit under section labels with icon badge, name and a dial, and show no status text at rest", async ({ page }) => {
    const card = await openPicker(page);
    await expect(card.locator(".cam-group-label")).toHaveText(["Subscriptions", "API credit"]);
    await expect(card.locator(".cam-row")).toHaveCount(4);
    // Subscriptions first, then the API-credit accounts, each with its own badge and a dial.
    await expect(card.locator(".cam-row .cam-row-name")).toHaveText(["Personal", "Work", "API credit", "Spare key"]);
    await expect(card.locator(".cam-row .account-icon-badge")).toHaveCount(4);
    await expect(card.locator(".cam-row .oc-dial")).toHaveCount(4);
    await expect(card.locator('[data-acc-id="acct-credit"] .account-icon-badge .ph-key')).toHaveCount(1);
    await expect(card.locator(".cam-credit-hint")).toHaveCount(0);

    // The current account (auto-picked Personal) is tinted and carries the accent bar.
    const current = card.locator('[data-acc-id="acct-personal"]');
    await expect(current).toHaveClass(/sel/);
    expect(await current.evaluate((el) => getComputedStyle(el).boxShadow)).toMatch(/inset/);
    expect(await current.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px");

    // At rest the figures are invisible; only the limited account shows a flag.
    for (const id of ["acct-personal", "acct-credit", "acct-spare"]) {
      await settledOpacity(card.locator(`[data-acc-id="${id}"] .cam-limit-text`), "0");
    }
    const flag = card.locator('[data-acc-id="acct-work"] .cam-flag');
    await expect(flag.locator(".cam-pill")).toHaveText("5h limit");
    await expect(flag.locator(".cam-back")).toHaveText(/^back in \d+m$/);
    await expect(card.locator(".cam-flag")).toHaveCount(1);
    await expect(card.locator('[data-acc-id="acct-work"] .cam-limit-text')).toHaveCount(0);

    // API credit draws one ring; a subscription draws two.
    const ringsOf = (id: string) =>
      card.locator(`[data-acc-id="${id}"] .oc-dial svg circle`).evaluateAll((cs) =>
        new Set(cs.filter((c) => getComputedStyle(c).display !== "none").map((c) => c.getAttribute("r"))).size);
    expect(await ringsOf("acct-credit")).toBe(1);
    expect(await ringsOf("acct-personal")).toBe(2);

    // The dial is ~26px.
    const box = await card.locator('[data-acc-id="acct-personal"] .oc-dial').boundingBox();
    expect(Math.round(box!.width)).toBe(26);

    await capture(card, "change-account-picker-rest");
  });

  test("hovering a row shows its figures as inline text, not a popover", async ({ page }) => {
    const card = await openPicker(page);
    const personal = card.locator('[data-acc-id="acct-personal"]');
    await personal.hover();
    const text = personal.locator(".cam-limit-text");
    await expect(text).toHaveText("5h 20% 7d 49%");
    await settledOpacity(text, "1");
    // Inline: inside the row's own box, left of the dial.
    const [row, t, dial] = await Promise.all([
      personal.boundingBox(), text.boundingBox(), personal.locator(".oc-dial").boundingBox(),
    ]);
    expect(t!.x).toBeGreaterThanOrEqual(row!.x);
    expect(t!.x + t!.width).toBeLessThanOrEqual(dial!.x + 1);
    await expect(page.locator("[role=tooltip], .tooltip, .popover")).toHaveCount(0);
    await capture(card, "change-account-picker-hover-subscription");

    const creditRow = card.locator('[data-acc-id="acct-credit"]');
    await creditRow.hover();
    await expect(creditRow.locator(".cam-limit-text")).toHaveText("$174.27 of $200 left");
    await settledOpacity(creditRow.locator(".cam-limit-text"), "1");
    await settledOpacity(personal.locator(".cam-limit-text"), "0");

    const spare = card.locator('[data-acc-id="acct-spare"]');
    await spare.hover();
    await expect(spare.locator(".oc-ic-unknown")).toHaveText("?");
    await expect(spare.locator(".cam-limit-text")).toHaveText("Balance unknown");
    await settledOpacity(spare.locator(".cam-limit-text"), "1");
  });

  test("a limited account keeps its flag on hover and adds nothing", async ({ page }) => {
    const card = await openPicker(page);
    const work = card.locator('[data-acc-id="acct-work"]');
    await work.hover();
    await expect(work.locator(".cam-pill")).toBeVisible();
    await expect(work.locator(".cam-back")).toBeVisible();
    await expect(work.locator(".cam-limit-text")).toHaveCount(0);
    await capture(card, "change-account-picker-hover-limited");
  });

  test("keyboard focus shows the same inline text, and number keys and Enter still pick", async ({ page }) => {
    const card = await openPicker(page);
    const credit = card.locator('[data-acc-id="acct-credit"]');
    await credit.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(credit).toBeFocused();
    await expect(credit.locator(".cam-limit-text")).toHaveText("$174.27 of $200 left");
    await settledOpacity(credit.locator(".cam-limit-text"), "1");
    // The number badges are unchanged: 1-4 in screen order.
    await expect(card.locator(".modal-option-badge")).toHaveText(["1", "2", "3", "4"]);
    await page.keyboard.press("2");
    await expect(page.locator(".cam-modal-card")).toHaveCount(0);
    await expect(page.locator("#session-pane .sb-account")).toHaveAttribute("aria-label", "Work");
  });

  test("at phone width the rows stay inside the card, the figures are hidden and the flag stays", async ({ page }) => {
    await page.setViewportSize({ width: 380, height: 760 });
    const card = await openPicker(page);
    await expect(card.locator(".cam-limit-text").first()).toBeHidden();
    await expect(card.locator('[data-acc-id="acct-work"] .cam-pill')).toBeVisible();
    const cardBox = (await card.boundingBox())!;
    const overflowing = await card.locator(".cam-row").evaluateAll(
      (rows, right) => rows.filter((r) => r.getBoundingClientRect().right > (right as number) + 1).length,
      cardBox.x + cardBox.width,
    );
    expect(overflowing).toBe(0);
    await capture(card, "change-account-picker-phone");
  });
});
