// asserts: src/views/sessions/next-chips.ts, src/views/sessions/next-chip-strip.ts, src/views/sessions/session-thinking-bar.ts, src/views/sessions/active-session.ts
import { expect, test, type Page } from "@playwright/test";
import { invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

const EMPTY_TRANSCRIPT = { events: [], oldest_seq: 0, newest_seq: 0, has_more: false };

async function mountChat(
  page: Page,
  over: Parameters<typeof sessionInstance>[0] = {},
  extra: Record<string, unknown> = {},
): Promise<void> {
  const sess = sessionInstance(over);
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [sess],
      get_active_sessions: [sess],
      load_history_page: EMPTY_TRANSCRIPT,
      send_message: null,
      ...extra,
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().click();
  await page.locator("#session-pane .session-composer").first().waitFor();
}

const chip = (page: Page) => page.locator("#session-pane .next-chip-slot .next-chip");
// The preview panel's reply bar has a textarea of the same class, so scope to the chat's own composer.
const box = (page: Page) => page.locator("#session-pane .session-composer .composer-textarea");

test.describe("quick reply chips", () => {
  test("a finished chat offers /close above the message box", async ({ page }) => {
    await mountChat(page);
    await expect(chip(page)).toHaveText(["/close"]);
    const chipBox = (await chip(page).boundingBox())!;
    const composerBox = (await page.locator("#session-pane .composer-shell").boundingBox())!;
    expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(composerBox.y);
  });

  test("a click fills the box with the command first and keeps what was typed", async ({ page }) => {
    await mountChat(page);
    await box(page).fill("it worked");
    await chip(page).click();
    await expect(box(page)).toHaveValue("/close it worked");
    expect((await invokeCalls(page)).some((c) => JSON.stringify(c.args ?? "").includes("/close"))).toBe(false);
  });

  test("Shift+click on an empty box sends the command", async ({ page }) => {
    await mountChat(page);
    await chip(page).click({ modifiers: ["Shift"] });
    await expect.poll(async () => (await invokeCalls(page)).some((c) => JSON.stringify(c.args ?? "").includes("/close"))).toBe(true);
  });

  test("Shift+click with text typed fills instead of sending", async ({ page }) => {
    await mountChat(page);
    await box(page).fill("it worked");
    await chip(page).click({ modifiers: ["Shift"] });
    await expect(box(page)).toHaveValue("/close it worked");
    expect((await invokeCalls(page)).some((c) => JSON.stringify(c.args ?? "").includes("/close"))).toBe(false);
  });

  for (const [label, over] of [
    ["mid-turn", { busy: true, awaiting: null }],
    ["waiting on a question", { awaiting: "question" }],
  ] as const) {
    test(`no chip while the chat is ${label}`, async ({ page }) => {
      await mountChat(page, over);
      await expect(page.locator("#session-pane .next-chip-slot")).toBeHidden();
    });
  }

  test("turning Wrap up when done on hides the chip at once, off brings it back", async ({ page }) => {
    await mountChat(page, {}, { set_wrap_up_on_done: null, list_wrap_up_on_done: [] });
    await expect(chip(page)).toHaveText(["/close"]);
    const flip = (on: boolean) => page.evaluate(async (value) => {
      const gating = await import("/views/sessions/permission-modal/gating.ts");
      gating.setWrapUpOnDone("s1", value);
    }, on);
    await flip(true);
    await expect(chip(page)).toHaveCount(0);
    await flip(false);
    await expect(chip(page)).toHaveText(["/close"]);
  });

  test("no chip with the setting off", async ({ page }) => {
    await mountChat(page, {}, { get_settings: { nextActionChips: false } });
    await expect(page.locator("#session-pane .next-chip-slot")).toBeHidden();
  });
});

const userEvent = (text: string) => ({ type: "user_message", content: [{ type: "text", text }], timestamp: 0, remote_echo: false, is_meta: false });
const sendMessageEvent = (text: string, nextActions?: unknown) => ({
  type: "tool_use",
  tool_name: "mcp__cc_conductor__send_message",
  input: { text, ...(nextActions === undefined ? {} : { next_actions: nextActions }) },
  id: `tu-${text}`,
  timestamp: 0,
  parent_tool_use_id: null,
});
const transcript = (...events: unknown[]) => ({ events, oldest_seq: 0, newest_seq: 0, has_more: false });

test.describe("quick reply chips written by the model", () => {
  const proposal = transcript(userEvent("plan it"), sendMessageEvent("Plan ready.", ["Yes, implement this", "/commit", "/close"]));

  test("its replies sit after /close, and a model-written /close is not doubled", async ({ page }) => {
    await mountChat(page, {}, { load_history_page: proposal });
    await expect(chip(page)).toHaveText(["/close", "Yes, implement this", "/commit"]);
  });

  test("a reply fills an empty box, Shift+click on an empty box sends it", async ({ page }) => {
    await mountChat(page, {}, { load_history_page: proposal });
    await chip(page).filter({ hasText: "Yes, implement this" }).click();
    await expect(box(page)).toHaveValue("Yes, implement this");
    await box(page).fill("");
    await chip(page).filter({ hasText: "Yes, implement this" }).click({ modifiers: ["Shift"] });
    await expect.poll(async () => (await invokeCalls(page)).some((c) => JSON.stringify(c.args ?? "").includes("Yes, implement this"))).toBe(true);
  });

  test("a reply goes above what was typed, and a second click does not stack it", async ({ page }) => {
    await mountChat(page, {}, { load_history_page: proposal });
    await box(page).fill("but keep the old name");
    const reply = chip(page).filter({ hasText: "Yes, implement this" });
    await reply.click();
    await expect(box(page)).toHaveValue("Yes, implement this\nbut keep the old name");
    await reply.click();
    await expect(box(page)).toHaveValue("Yes, implement this\nbut keep the old name");
  });

  test("a slash reply puts its command first like /close does", async ({ page }) => {
    await mountChat(page, {}, { load_history_page: proposal });
    await box(page).fill("everything");
    await chip(page).filter({ hasText: "/commit" }).click();
    await expect(box(page)).toHaveValue("/commit everything");
  });

  test("the replies are gone once Joe has written after them", async ({ page }) => {
    await mountChat(page, {}, { load_history_page: transcript(...proposal.events, userEvent("ok go")) });
    await expect(chip(page)).toHaveText(["/close"]);
  });

  test("only the newest message counts: an older proposal does not outlive the message that replaced it", async ({ page }) => {
    await mountChat(page, {}, { load_history_page: transcript(userEvent("plan it"), sendMessageEvent("Plan ready.", ["Go"]), sendMessageEvent("Done.")) });
    await expect(chip(page)).toHaveText(["/close"]);
  });
});

test.describe("quick reply chips on the phone", () => {
  test.use({ viewport: { width: 390, height: 780 } });

  test("the row stays inside the screen", async ({ page }) => {
    await mountChat(page);
    await expect(chip(page)).toHaveText(["/close"]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
