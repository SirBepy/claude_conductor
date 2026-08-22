import { expect, test, type Page } from "@playwright/test";
import { capture, invokeCalls, mountView, sessionInstance, SESSIONS_BASE_INVOKE } from "./harness";

// Todo 645: the frozen-chat hold-vs-send-now popover (commit aa9b7653), shot
// against the real cascade instead of the live daemon the todo's approach
// assumed - both branches run for real here, only the backend is mocked.
const DESKTOP = { width: 1400, height: 900 };
const DRAFT = "Ship the frozen-chat fix";

const FROZEN = sessionInstance({ name: "Frozen chat", frozen: true });

const INVOKE = {
  ...SESSIONS_BASE_INVOKE,
  list_instances: [FROZEN],
  get_active_sessions: [FROZEN],
  load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
  list_previews: [],
  list_slash_commands: [],
  get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
  set_composer_draft: { updated_at: "2026-08-22T10:00:00Z" },
  clear_composer_draft: { updated_at: "2026-08-22T10:00:00Z" },
  add_held_message: { id: 11, updated_at: "2026-08-22T10:00:00Z" },
  unfreeze_session: null,
  send_message: null,
};

/** Mount the frozen session, type a draft, hit Send, return the open popover. */
async function openChoice(page: Page) {
  await page.setViewportSize(DESKTOP);
  await mountView(page, { view: "sessions", invoke: INVOKE });
  await page.locator(`#sessions-list li[data-session-id='${FROZEN.session_id}']`).click();

  const textarea = page.locator("#session-pane .session-composer .composer-textarea");
  await textarea.waitFor();
  // The mount's draft round trip can re-render the composer under us; typing
  // only after it lands keeps the send button from being swapped mid-click.
  await expect
    .poll(async () => (await invokeCalls(page)).map((c) => c.cmd))
    .toContain("get_session_drafts");
  await textarea.fill(DRAFT);
  await page.locator("#session-pane .composer-send").click();

  const pop = page.locator(".composer-frozen-choice-popover");
  await expect(pop).toHaveCount(1);
  await expect(pop).toBeVisible();
  await expect(pop).toContainText("This chat is frozen");
  await expect(pop.locator('[data-choice="hold"]')).toContainText("Hold - send once unfrozen");
  await expect(pop.locator('[data-choice="now"]')).toContainText("Send now (unfreezes chat)");
  return { pop, textarea };
}

test.describe("@shot", () => {
  test.skip(!process.env.CC_SHOTS, "capture-only, run it with CC_SHOTS=1");

  test("Hold stages the draft as a held message", async ({ page }) => {
    const { pop, textarea } = await openChoice(page);
    await capture(pop, "frozen-choice-popover");

    await pop.locator('[data-choice="hold"]').click();

    await expect(page.locator(".composer-frozen-choice-popover")).toHaveCount(0);
    await expect(textarea).toHaveValue("");
    const shell = page.locator("#session-pane .composer-shell");
    await expect(shell.locator(".held-chip")).toBeVisible();
    await expect(shell.locator(".held-count")).toHaveText("1");
    await expect(shell.locator(".thinking-text")).toHaveText("Frozen - will send once unfrozen");
    // Hold must NOT touch the wire beyond staging.
    const calls = await invokeCalls(page);
    expect(calls.some((c) => c.cmd === "send_message")).toBe(false);
    expect(calls.some((c) => c.cmd === "unfreeze_session")).toBe(false);
    await capture(shell, "frozen-choice-after-hold");
  });

  test("Send now unfreezes and sends for real", async ({ page }) => {
    const { pop, textarea } = await openChoice(page);
    await pop.locator('[data-choice="now"]').click();

    await expect(page.locator(".composer-frozen-choice-popover")).toHaveCount(0);
    await expect(textarea).toHaveValue("");
    await expect
      .poll(async () => (await invokeCalls(page)).map((c) => c.cmd))
      .toContain("send_message");

    const calls = await invokeCalls(page);
    const sent = calls.find((c) => c.cmd === "send_message");
    expect(JSON.stringify(sent?.args)).toContain(DRAFT);
    expect(calls.some((c) => c.cmd === "unfreeze_session")).toBe(true);
    expect(calls.some((c) => c.cmd === "add_held_message")).toBe(false);

    const pane = page.locator("#session-pane");
    await expect(pane.locator(".session-messages")).toContainText(DRAFT);
    await expect(pane.locator(".held-chip")).toHaveCount(0);
    await capture(pane, "frozen-choice-after-send-now");
  });
});
