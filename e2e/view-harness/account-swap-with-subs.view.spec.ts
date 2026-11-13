import { expect, test } from "@playwright/test";
import { SESSIONS_BASE_INVOKE, capture, invokeCalls, mountView, sessionInstance } from "./harness";

// asserts: src/shared/chat/rate-limit-banner.ts, src/shared/change-account-modal.ts, src/views/sessions/account-move.ts, src/views/sessions/active-session-account.ts, src/views/sessions/sessions-wiring.ts

// Joe 2026-11-13: swapping a main chat's account should take its subs along in
// one action, and the rate-limit banner must ask which account instead of
// guessing one (it suggested the account that was not working).

// The transport hands JSON numbers back for this bigint-typed field, so the
// fixture matches the wire shape rather than the generated type.
const resetsAtSecs = (msFromNow: number): bigint =>
  Math.floor((Date.now() + msFromNow) / 1000) as unknown as bigint;

const ACCOUNTS = [
  { id: "acc-1", label: "personal", icon: "user", colour: "#8b5cf6" },
  { id: "acc-2", label: "work", icon: "briefcase", colour: "#57b894" },
  { id: "acc-credit", label: "API credit", icon: "user", colour: "#10b981", kind: "api_credit" },
];

test("the banner's Switch account opens the picker and moves the main chat and its subs", async ({ page }) => {
  const limited = { rate_limited_resets_at: resetsAtSecs(2 * 3_600_000), rate_limited_type: "five_hour" };
  const main = sessionInstance({ session_id: "s-main", name: "Main chat", account_id: "acc-1", ...limited });
  const subA = sessionInstance({ session_id: "s-sub-a", name: "Sub A", account_id: "acc-1", subchat_of: "s-main", ...limited });
  const subB = sessionInstance({ session_id: "s-sub-b", name: "Sub B", account_id: "acc-1", subchat_of: "s-main", ...limited });
  const all = [main, subA, subB];
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_accounts: ACCOUNTS,
      list_instances: all, get_active_sessions: all,
      move_session_to_account: "s-main",
    },
  });

  const banner = page.locator(".rate-limit-banner");
  await expect(banner.locator(".rlb-move")).toHaveText("Switch account");
  await banner.locator(".rlb-move").click();

  const modal = page.locator(".cam-modal-card");
  await expect(modal.locator(".cam-subs-row")).toContainText("Also move its 2 subchats");
  await expect(modal.locator(".cam-subs-input")).toBeChecked();
  await expect(modal.locator('[data-acc-id="acc-credit"]')).toHaveCount(0);
  await capture(modal, "account-swap-picker-with-subs");

  await modal.locator('[data-acc-id="acc-2"]').click();
  await expect.poll(async () =>
    (await invokeCalls(page)).filter((c) => c.cmd === "move_session_to_account").map((c) => c.args),
  ).toEqual([
    { sessionId: "s-main", targetAccountId: "acc-2" },
    { sessionId: "s-sub-a", targetAccountId: "acc-2" },
    { sessionId: "s-sub-b", targetAccountId: "acc-2" },
  ]);
});
