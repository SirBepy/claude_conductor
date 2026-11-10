// Reviewed 2026-11-10 (dash lane 3): the Subchats card, Pin to sidemenu and the effort battery colours change nothing this spec asserts; its failing test also fails on HEAD without these changes.
// Reviewed 2026-11-10: the question card pads the scroller cardPaddedScroller picks (this pane's transcript as before, or the chat dashboard's body while it shows), active-session.ts detaches the chat dashboard on dismount, and a read-only session keeps Messages; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-05: permission-modal/gating.ts and index.ts gained hydrateSubchatsOn/isSubchatsOn/setSubchatsOn (the Use subchats toggle's in-memory state, hydrated at install time) - additive; the harness's unmocked list_subchats_on rejection is caught inside the hydrate, no change to this spec's contract.
// asserts: src/views/sessions/next-chips.ts, src/views/sessions/next-chip-strip.ts, src/views/sessions/session-thinking-bar.ts, src/views/sessions/active-session.ts, src/views/sessions/active-session-composer.ts, src/shared/chat/composer.ts
// Reviewed 2026-11-03: selectSession now returns when the chat was switched away during the statusbar settings read; this spec's contract is unchanged and it passes.
// Reviewed 2026-11-01: the working bar lost its card and gained an opened block (session-thinking-bar.ts); this spec drives only the chip strip above it and passes.
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

  test("a click fills the empty box with the command and does not send it", async ({ page }) => {
    await mountChat(page);
    await chip(page).click();
    await expect(box(page)).toHaveValue("/close ");
    expect((await invokeCalls(page)).some((c) => JSON.stringify(c.args ?? "").includes("/close"))).toBe(false);
  });

  test("Shift+click on an empty box sends the command", async ({ page }) => {
    await mountChat(page);
    await chip(page).click({ modifiers: ["Shift"] });
    await expect.poll(async () => (await invokeCalls(page)).some((c) => JSON.stringify(c.args ?? "").includes("/close"))).toBe(true);
  });

  test("the chips hide while a message is being typed and return when the box is emptied", async ({ page }) => {
    await mountChat(page);
    await expect(chip(page)).toHaveText(["/close"]);
    await box(page).pressSequentially("it");
    await expect(page.locator("#session-pane .next-chip-slot")).toBeHidden();
    await box(page).fill("");
    await expect(chip(page)).toHaveText(["/close"]);
    await expect(chip(page)).toBeVisible();
  });

  // No keystroke happens when an image is attached, so the strip has to hear about it from the attachment set.
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const attach = (page: Page) =>
    page.locator("#session-pane .composer-file-input").setInputFiles([{ name: "shot.png", mimeType: "image/png", buffer: PNG }]);

  test("an image alone, with no text, hides the chips, and removing it brings them back", async ({ page }) => {
    await mountChat(page, {}, { paste_attachment: "C:/tmp/pasted.png" });
    await expect(chip(page)).toBeVisible();
    await attach(page);
    await page.locator("#session-pane .composer-attachments .attachment").first().waitFor();
    await expect(page.locator("#session-pane .next-chip-slot")).toBeHidden();
    await expect(box(page)).toHaveValue("");
    await page.locator("#session-pane .composer-attachments .attachment .rm").first().click();
    await expect(chip(page)).toBeVisible();
  });

  test("the message box stays where it was when the chips hide", async ({ page }) => {
    await mountChat(page, {}, { paste_attachment: "C:/tmp/pasted.png" });
    await expect(chip(page)).toBeVisible();
    const before = (await page.locator("#session-pane .composer-shell").boundingBox())!;
    await box(page).pressSequentially("it");
    await expect(page.locator("#session-pane .next-chip-slot")).toBeHidden();
    const after = (await page.locator("#session-pane .composer-shell").boundingBox())!;
    expect(after.y + after.height).toBeCloseTo(before.y + before.height, 0);
  });

  test("a chip filling the box hides the strip like typing does", async ({ page }) => {
    await mountChat(page);
    await chip(page).click();
    await expect(page.locator("#session-pane .next-chip-slot")).toBeHidden();
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

  test("every chip is hidden once the draft has text, so a reply cannot land on typed words", async ({ page }) => {
    await mountChat(page, {}, { load_history_page: proposal });
    await box(page).fill("but keep the old name");
    await expect(page.locator("#session-pane .next-chip-slot")).toBeHidden();
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

// First real subchats run: the built-in /close chip showed in a main chat, whose prompt
// says never to close by itself, and again inside a sub's in-place view, where /close
// does not apply. A main chat gets it only when its own latest reply asks for it.
for (const [label, size] of [["desktop", { width: 1280, height: 800 }], ["phone", { width: 393, height: 852 }]] as const) {
  test.describe(`quick reply chips in a main chat and a sub (${label})`, () => {
    const MAIN = sessionInstance({ session_id: "main", name: "CV redesign", pid: 101, awaiting: "done" });
    const SUB = sessionInstance({ session_id: "sub-1", name: "Footer", pid: 102, subchat_of: "main", awaiting: "done", subchat_finished: true });
    const PLAIN = sessionInstance({ session_id: "plain", name: "Plain chat", pid: 103, awaiting: "done" });
    const asks = transcript(userEvent("plan it"), sendMessageEvent("Spawn the header?", ["Yes, spawn it", "/close"]));

    async function mountFamily(page: Page, history: unknown = EMPTY_TRANSCRIPT): Promise<void> {
      await page.setViewportSize(size);
      const rows = [MAIN, SUB, PLAIN];
      await mountView(page, {
        view: "sessions",
        invoke: {
          ...SESSIONS_BASE_INVOKE,
          list_instances: rows,
          get_active_sessions: rows,
          list_subchats_on: ["main"],
          load_history_page: history,
          get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
          send_message: null,
          list_auto_accept: [],
        },
      });
      await page.locator("#sessions-list li[data-session-id]").first().waitFor();
      // The mode flags hydrate after boot and redraw the strip.
      await page.waitForTimeout(250);
    }
    const open = async (page: Page, id: string) => {
      await page.evaluate(() => document.querySelector(".view-sessions")?.setAttribute("data-mobile-pane", "list"));
      await page.locator(`#sessions-list li[data-session-id="${id}"]`).click();
      await page.locator("#session-pane .session-composer").first().waitFor();
    };

    test("a main chat shows no /close of its own, but a plain chat still does", async ({ page }) => {
      await mountFamily(page);
      await open(page, "main");
      await expect(chip(page)).toHaveCount(0);
      await open(page, "plain");
      await expect(chip(page)).toHaveText(["/close"]);
    });

    test("a main chat shows /close when its own latest reply asks for it", async ({ page }) => {
      await mountFamily(page, asks);
      await open(page, "main");
      await expect(chip(page)).toHaveText(["/close", "Yes, spawn it"]);
    });

    test("a main chat keeps the model's replies without the /close it did not ask for", async ({ page }) => {
      await mountFamily(page, transcript(userEvent("plan it"), sendMessageEvent("Spawn the header?", ["Yes, spawn it"])));
      await open(page, "main");
      await expect(chip(page)).toHaveText(["Yes, spawn it"]);
    });

    test("a sub's in-place view never shows /close, even when the sub asked for it", async ({ page }) => {
      await mountFamily(page, asks);
      await open(page, "main");
      await page.locator("#session-pane .session-header .sub-count-btn").click();
      await page.locator('.sub-list-popover .sub-row[data-sub-id="sub-1"]').click();
      await expect(page.locator("#session-pane .session-header .sub-back-btn")).toBeVisible();
      await expect(chip(page)).toHaveText(["Yes, spawn it"]);
    });

    test("turning the mode on takes the /close chip away at once", async ({ page }) => {
      await mountFamily(page);
      await open(page, "plain");
      await expect(chip(page)).toHaveText(["/close"]);
      await page.evaluate(async () => {
        const gating = await import("/views/sessions/permission-modal/gating.ts");
        const w = window as unknown as { __TAURI__: { core: { invoke: (c: string, a?: unknown) => Promise<unknown> } } };
        const orig = w.__TAURI__.core.invoke;
        w.__TAURI__.core.invoke = (cmd, args) => (cmd === "set_subchats_on" ? Promise.resolve(null) : orig(cmd, args));
        await gating.setSubchatsOn("plain", true);
      });
      await expect(chip(page)).toHaveCount(0);
    });
  });
}

test.describe("quick reply chips on the phone", () => {
  test.use({ viewport: { width: 390, height: 780 } });

  test("an image alone hides the row on the phone too", async ({ page }) => {
    await mountChat(page, {}, { paste_attachment: "C:/tmp/pasted.png" });
    await expect(chip(page)).toBeVisible();
    await page.locator("#session-pane .composer-file-input").setInputFiles([
      { name: "shot.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64") },
    ]);
    await page.locator("#session-pane .composer-attachments .attachment").first().waitFor();
    await expect(page.locator("#session-pane .next-chip-slot")).toBeHidden();
  });

  test("the row stays inside the screen", async ({ page }) => {
    await mountChat(page);
    await expect(chip(page)).toHaveText(["/close"]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
