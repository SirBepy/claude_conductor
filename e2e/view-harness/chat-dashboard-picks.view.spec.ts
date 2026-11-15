import { test, expect, type Page } from "@playwright/test";
import { capture, invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance, userMsg } from "./harness";

// asserts: src/views/sessions/chat-dashboard/picks-card.ts, src/views/sessions/chat-dashboard/picks-card.css, src/shared/chat/dashboard/picks-model.ts

// The dashboard's Autopilot picks card (pc-1750): every choice the chat made by
// itself on an unattended run, with Agree and Overrule on each. Overrule saves
// Joe's answer and sends the correction to the main chat as his message.

const CWD = "C:/Projects/cv-site";
const MAIN = sessionInstance({ session_id: "main", name: "CV redesign", pid: 101, cwd: CWD });
const HISTORY = [userMsg("build the new CV site while I sleep")];

const pick = (id: string, over: Record<string, unknown> = {}) => ({
  id, date: `2026-11-15T0${id.slice(1)}:00:00+01:00`, who: "Footer", sub: "s1",
  question: `Choice ${id}: which header colour?`, options: ["Teal", "Navy"], pick: "Teal",
  reason: "It matches the logo.", landed: "src/header.css", status: "unreviewed", instead: null, corrected_note: null, ...over,
});

async function openMain(page: Page, picks: unknown[], extra: Record<string, unknown> = {}): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mountView(page, {
    view: "sessions",
    chatView: "dashboard",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [MAIN],
      get_active_sessions: [MAIN],
      list_subchats_on: ["main"],
      load_history_page: { events: HISTORY, oldest_seq: 0, newest_seq: HISTORY.length, has_more: false },
      context_status: { model: "claude-opus-5", window: 1_000_000, occupancy: 100_000, remaining: 900_000, pct_used: 10, pct_left: 90 },
      list_subchat_cards: [], list_previews: [], send_message: null,
      picks_state: { owner: "main", picks },
      ...extra,
    },
  });
  await page.locator(`#sessions-list li[data-session-id="main"]`).click();
  await page.locator("#session-pane .cdash").waitFor();
}

const card = (page: Page) => page.locator("#session-pane .cdash-left .cdash-picks");

test.describe("chat dashboard / Autopilot picks card", () => {
  test("an attended chat with no picks has no card", async ({ page }) => {
    await openMain(page, []);
    await expect(card(page)).toHaveCount(0);
  });

  test("lists each unreviewed pick with its options, reason and where it landed", async ({ page }) => {
    await openMain(page, [pick("P1"), pick("P2", { question: "Choice P2: footer layout?", options: ["One column", "Two columns"], pick: "Two columns" })]);
    await expect(card(page)).toBeVisible();
    await expect(card(page).locator(".pk-lead")).toContainText("2 choices Claude made without you");
    await expect(card(page).locator(".pk-item")).toHaveCount(2);
    // Newest first.
    expect(await card(page).locator(".pk-item").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.pk))).toEqual(["P2", "P1"]);
    const first = card(page).locator('.pk-item[data-pk="P1"]');
    await expect(first.locator(".pk-pick b")).toHaveText("Teal");
    await expect(first.locator(".pk-alts")).toHaveText("not Navy");
    await expect(first.locator(".pk-why")).toHaveText("It matches the logo.");
    await expect(first.locator(".pk-meta")).toContainText("src/header.css");
    await capture(page.locator("#session-pane"), "pc-1750-picks-card");
  });

  test("Agree saves the review and moves the pick into the reviewed fold", async ({ page }) => {
    await openMain(page, [pick("P1")], {
      picks_review: { owner: "main", picks: [pick("P1", { status: "agreed" })] },
    });
    await card(page).locator('.pk-item[data-pk="P1"] [data-pk-act="agree"]').click();
    await expect(card(page).locator(".pk-lead")).toHaveText("Everything is reviewed.");
    await expect(card(page).locator(".pk-item")).toHaveCount(0);
    await expect(card(page).locator(".pk-fold")).toContainText("1 reviewed");
    const call = (await invokeCalls(page)).find((c) => c.cmd === "picks_review");
    expect(call?.args).toMatchObject({ sessionId: "main", id: "P1", action: "agree" });
    await card(page).locator(".pk-fold").click();
    await expect(card(page).locator('.pk-item[data-pk="P1"] .pk-chip')).toHaveText("Agreed");
  });

  test("Overrule asks what he wants, saves it and sends the correction to the chat", async ({ page }) => {
    await openMain(page, [pick("P1")], {
      picks_review: { owner: "main", picks: [pick("P1", { status: "overruled", instead: "Navy, the brand changed" })] },
    });
    const row = card(page).locator('.pk-item[data-pk="P1"]');
    await row.locator('[data-pk-act="overrule-open"]').click();
    const box = row.locator("textarea");
    await expect(box).toBeFocused();
    // Sending an empty box is refused, nothing is saved.
    await row.locator('[data-pk-act="overrule-send"]').click();
    expect((await invokeCalls(page)).some((c) => c.cmd === "picks_review")).toBe(false);
    await box.fill("Navy, the brand changed");
    await capture(page.locator("#session-pane"), "pc-1750-picks-overrule-box");
    await row.locator('[data-pk-act="overrule-send"]').click();

    await expect(card(page).locator(".pk-sect")).toContainText("To fix");
    await expect(card(page).locator('.pk-item[data-pk="P1"] .pk-instead')).toContainText("Navy, the brand changed");
    const calls = await invokeCalls(page);
    expect(calls.find((c) => c.cmd === "picks_review")?.args).toMatchObject({ id: "P1", action: "overrule", instead: "Navy, the brand changed" });
    const sent = calls.find((c) => c.cmd === "send_message");
    expect(JSON.stringify(sent?.args)).toContain("I overruled your autopilot pick P1");
    expect(JSON.stringify(sent?.args)).toContain('action \\"corrected\\", id \\"P1\\"');
    await capture(page.locator("#session-pane"), "pc-1750-picks-overruled");
  });

  test("a double click on Send to chat sends one correction", async ({ page }) => {
    await openMain(page, [pick("P1")], {
      picks_review: { owner: "main", picks: [pick("P1", { status: "overruled", instead: "Navy" })] },
    });
    const row = card(page).locator('.pk-item[data-pk="P1"]');
    await row.locator('[data-pk-act="overrule-open"]').click();
    await row.locator("textarea").fill("Navy");
    await row.locator('[data-pk-act="overrule-send"]').dblclick();
    await expect(card(page).locator(".pk-sect")).toContainText("To fix");
    const calls = await invokeCalls(page);
    expect(calls.filter((c) => c.cmd === "picks_review")).toHaveLength(1);
    expect(calls.filter((c) => c.cmd === "send_message")).toHaveLength(1);
  });

  test("an announcement re-reads the list, and typing in the overrule box survives it", async ({ page }) => {
    await openMain(page, [pick("P1")]);
    const row = card(page).locator('.pk-item[data-pk="P1"]');
    await row.locator('[data-pk-act="overrule-open"]').click();
    await row.locator("textarea").fill("half a sentence");
    // The daemon announces a change while Joe is typing: the list is re-read, the text and focus stay.
    await page.evaluate(() => {
      const w = window as unknown as { __ccListeners: Map<string, Set<(e: { payload: unknown }) => void>>; __ccInvokeMap?: Record<string, unknown> };
      w.__ccListeners.get("autopilot-picks-changed")?.forEach((cb) => cb({ payload: { session_id: "main", unreviewed: 2 } }));
    });
    await expect(row.locator("textarea")).toHaveValue("half a sentence");
    await expect(row.locator("textarea")).toBeFocused();
  });
});
