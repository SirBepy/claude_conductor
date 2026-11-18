// asserts: src/views/sessions/permission-modal/broker-card.ts
import { test, expect, type Page } from "@playwright/test";
import { invokeCalls, mountView } from "./harness";

// A made-up value: tests never carry a real token.
const CANARY = "canary-broker-token-0001";

type Card = Record<string, unknown>;

const IMPORT: Card = {
  kind: "import",
  machine: "this PC",
  store: "Windows protected store",
  rows: [
    { name: "FIGMA_TOKEN", label: "Figma", status: "copy", from: null },
    { name: "TRELLO_KEY", label: "Trello key", status: "copy", from: "TRELLO_API_KEY" },
    { name: "LINEAR_API_KEY", label: "Linear", status: "kept", from: null },
    { name: "SHORTCUT_API_TOKEN", label: "Shortcut", status: "missing", from: null },
  ],
};
const REPLACE: Card = {
  kind: "replace",
  name: "FIGMA_TOKEN",
  label: "Figma",
  purpose: "Reads designs for the figma tools.",
  create_url: "https://www.figma.com/settings",
  stored: true,
  machine: "this PC",
  store: "Windows protected store",
};
const POLICY: Card = {
  kind: "policy",
  service: "linear",
  method: "POST",
  path: "/graphql",
  op: "issueCreate",
  require_owner: false,
  line: '{"service":"linear","method":"POST","path":"/graphql","op":"issueCreate"}',
  file: "C:\\Users\\joe\\broker-policy.json",
};

async function mount(page: Page, card: Card, answer: unknown = { ok: true, stored: ["FIGMA_TOKEN"] }) {
  await mountView(page, { invoke: { list_slash_commands: [], respond_broker_card: answer } });
  await page.evaluate(async (data) => {
    const mod = await import("/views/sessions/permission-modal/broker-card.ts");
    (window as unknown as { __settled: number }).__settled = 0;
    mod.showBrokerCard(
      {
        id: "broker-1",
        session_id: "ghost",
        questions: [],
        daemon_card: true,
        card_kind: `broker_${(data as { kind: string }).kind}`,
        broker_card: data,
      } as never,
      { onSettled: () => { (window as unknown as { __settled: number }).__settled += 1; } },
    );
  }, card);
  return page.locator(".prompt-card");
}

const answers = async (page: Page) => (await invokeCalls(page)).filter((c) => c.cmd === "respond_broker_card");

test.describe("view-harness / broker cards", () => {
  test("the import card lists every row with its state, and says no value is shown", async ({ page }) => {
    const card = await mount(page, IMPORT);
    await expect(card.locator(".prompt-card__title")).toHaveText(/Import tokens/);
    await expect(card.locator(".broker-card__row")).toHaveCount(4);
    await expect(card.locator(".broker-card__row--copy")).toHaveCount(2);
    await expect(card.locator(".broker-card__row--missing")).toContainText("Not in .env");
    await expect(card.locator(".broker-card__row--copy").nth(1)).toContainText("from TRELLO_API_KEY");
    await expect(card.locator('[data-act="approve"]')).toHaveText("Import 2");
    await expect(card).toContainText("no value is shown");
  });

  test("approving the import sends the answer, shows the result, then the card leaves", async ({ page }) => {
    const card = await mount(page, IMPORT, { ok: true, stored: ["FIGMA_TOKEN", "TRELLO_KEY"], failed: [] });
    await card.locator('[data-act="approve"]').click();
    await expect(card.locator(".broker-card__result")).toContainText("Imported 2 tokens");
    expect(await answers(page)).toEqual([{ cmd: "respond_broker_card", args: { requestId: "broker-1", action: "approve", value: null } }]);
    await expect(page.locator(".prompt-card")).toHaveCount(0, { timeout: 6000 });
    expect(await page.evaluate(() => (window as unknown as { __settled: number }).__settled)).toBe(1);
  });

  test("declining sends a decline and changes nothing", async ({ page }) => {
    const card = await mount(page, POLICY, { ok: true, declined: true });
    await card.locator('[data-act="decline"]').click();
    await expect(card.locator(".broker-card__result")).toContainText("Declined");
    expect((await answers(page))[0]!.args).toMatchObject({ action: "decline", value: null });
  });

  test("the replace card keeps Save off until a token is typed, and the token goes only into the answer call", async ({ page }) => {
    const card = await mount(page, REPLACE);
    await expect(card.locator(".prompt-card__title")).toHaveText(/Replace token/);
    await expect(card.locator(".secret-card__ledger")).toContainText("FIGMA_TOKEN");
    const save = card.locator('[data-act="approve"]');
    await expect(save).toBeDisabled();
    const input = card.locator(".secret-card__input");
    await input.fill(CANARY);
    await expect(save).toBeEnabled();
    await input.press("Enter");
    await expect(card.locator(".broker-card__result")).toContainText("Token saved");
    const calls = await answers(page);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual({ requestId: "broker-1", action: "approve", value: CANARY });
    // Nowhere on the page after the save: not the card, not the document.
    expect(await page.evaluate((v) => document.documentElement.outerHTML.includes(v), CANARY)).toBe(false);
  });

  test("an unstored token reads Add token", async ({ page }) => {
    const card = await mount(page, { ...REPLACE, stored: false });
    await expect(card.locator(".prompt-card__title")).toHaveText(/Add token/);
  });

  test("the policy card shows the exact line and the call it allows", async ({ page }) => {
    const card = await mount(page, POLICY);
    await expect(card.locator(".prompt-card__title")).toHaveText(/Allow this call/);
    await expect(card.locator(".secret-card__ledger")).toContainText("POST /graphql");
    await expect(card.locator(".secret-card__ledger")).toContainText("issueCreate");
    await expect(card.locator(".broker-card__line")).toHaveText(POLICY.line as string);
    await expect(card.locator('[data-act="approve"]')).toHaveText("Allow");
  });

  test("a refused answer shows the reason on the card, keeps it open and empties the paste", async ({ page }) => {
    const card = await mount(page, REPLACE, { ok: false, error: "the protected store is locked" });
    const input = card.locator(".secret-card__input");
    await input.fill(CANARY);
    await card.locator('[data-act="approve"]').click();
    await expect(card.locator(".broker-card__error.is-open")).toContainText("the protected store is locked");
    await expect(input).toHaveValue("");
    await expect(card.locator('[data-act="approve"]')).toBeDisabled();
    await expect(card.locator(".broker-card__result")).toHaveCount(0);
  });

  test("minimizing folds the card to a bar, and restoring keeps the typed paste", async ({ page }) => {
    const card = await mount(page, REPLACE);
    await card.locator(".secret-card__input").fill(CANARY);
    await card.locator('[data-act="minimize"]').click();
    await expect(card).toBeHidden();
    await expect(page.locator(".prompt-collapsed")).toContainText("Replace token");
    await page.locator(".prompt-collapsed").click();
    await expect(card).toBeVisible();
    await expect(card.locator(".secret-card__input")).toHaveValue(CANARY);
  });

  test("Escape folds the card instead of declining it", async ({ page }) => {
    const card = await mount(page, IMPORT);
    await page.keyboard.press("Escape");
    await expect(card).toBeHidden();
    await expect(page.locator(".prompt-collapsed")).toBeVisible();
    expect(await answers(page)).toHaveLength(0);
  });

  test("the card moves: rows ease in and the card enters, and reduced motion drops to a fade", async ({ page }) => {
    const card = await mount(page, IMPORT);
    await expect(card.locator(".broker-card__row").first()).toHaveCSS("animation-name", "broker-row-in");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(card.locator(".broker-card__row").first()).toHaveCSS("animation-name", "broker-fade");
  });
});
