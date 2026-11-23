// Reviewed 2026-11-23: Endpoint accounts and the Models & providers page do not change what this spec asserts.
// Reviewed 2026-11-16 (chat heads, pc-1769): the sidebar segments are gone, so the frozen chat is a head in the stack and there is no group to expand.
// asserts: src/views/sessions/frozen-limit-strip.ts
import { expect, test } from "@playwright/test";
import { capture, invokeCalls, mountView, sessionInstance, SESSIONS_BASE_INVOKE } from "./harness";

// 2026-11-13, "frozen chats can't get unfrozen": a chat the daemon froze for a
// usage limit offers the move to another account right above its composer, in
// the real pane cascade, without the in-memory rate-limit stamp the global
// banner needs.
const DESKTOP = { width: 1400, height: 900 };

const account = (id: string, label: string, kind: "subscription" | "api_credit") => ({
  id, label, colour: "#8b5cf6", icon: "user", config_dir: "", chrome_profile_dir: "",
  email: "joe@example.com", org_uuid: "org-1", subscription_tier: "claude_max", created_at: "2026-01-01T00:00:00Z",
  fleet_eligible: false, kind,
});
const PERSONAL = account("acct-personal", "personal", "subscription");
const CREDIT = account("acct-credit", "Personal API", "api_credit");
const DANE = account("acct-dane", "dane", "subscription");

const FROZEN = sessionInstance({
  name: "ZNG kickoff hub", account_id: PERSONAL.id, frozen: true, auto_frozen: true,
});

const INVOKE = {
  ...SESSIONS_BASE_INVOKE,
  list_instances: [FROZEN],
  get_active_sessions: [FROZEN],
  list_accounts: [PERSONAL, CREDIT, DANE],
  load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
  list_previews: [],
  list_slash_commands: [],
  get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
  move_session_to_account: FROZEN.session_id,
};

test("an auto-frozen chat offers Continue on the other plan account above its composer", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await mountView(page, { view: "sessions", invoke: INVOKE });
  await page.locator(`#sessions-list li[data-session-id='${FROZEN.session_id}']`).click();

  const strip = page.locator("#session-pane .frozen-limit-strip");
  await expect(strip).toBeVisible();
  await expect(strip).toContainText("Personal is out of usage, so this chat is paused");
  const move = strip.locator(".fls-move");
  await expect(move).toHaveText(/Continue on Dane/);
  await expect(strip).not.toContainText("Personal API");
  await expect(strip.locator(".fls-change")).toBeVisible();
  if (process.env.CC_SHOTS) await capture(page.locator("#session-pane"), "frozen-limit-strip");

  await move.click();
  await expect
    .poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "move_session_to_account"))
    .toHaveLength(1);
  const call = (await invokeCalls(page)).find((c) => c.cmd === "move_session_to_account");
  expect(call?.args).toMatchObject({ sessionId: FROZEN.session_id, targetAccountId: DANE.id });
});

test("a manually frozen chat gets no usage-limit strip", async ({ page }) => {
  const manual = { ...FROZEN, auto_frozen: false };
  await page.setViewportSize(DESKTOP);
  await mountView(page, { view: "sessions", invoke: { ...INVOKE, list_instances: [manual], get_active_sessions: [manual] } });
  await page.locator(`#sessions-list li[data-session-id='${manual.session_id}']`).click();
  await page.locator("#session-pane .session-composer .composer-textarea").waitFor();
  await expect(page.locator("#session-pane .frozen-limit-strip")).toHaveCount(0);
});

// 2026-11-18 (pc-1769): the daemon's idle freeze is `frozen && auto_frozen` too, but it is no
// limit. Its `idle_frozen` marker keeps the strip away, and opening the chat wakes it silently.
test("an idle-frozen chat shows no usage-limit strip and opening it wakes it", async ({ page }) => {
  const idle = { ...FROZEN, idle_frozen: true };
  await page.setViewportSize(DESKTOP);
  await mountView(page, { view: "sessions", invoke: { ...INVOKE, list_instances: [idle], get_active_sessions: [idle], unfreeze_session: { ok: true } } });
  await page.locator(`#sessions-list li[data-session-id='${idle.session_id}']`).click();
  await page.locator("#session-pane .session-composer .composer-textarea").waitFor();
  await expect(page.locator("#session-pane .frozen-limit-strip")).toHaveCount(0);
  await expect
    .poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "unfreeze_session"))
    .toHaveLength(1);
});
