// asserts: src/views/sessions/composer-typing.ts, src/views/sessions/next-chip-strip.ts, src/views/sessions/pending-pane-composer.ts, src/views/sessions/project-dashboard/draft-dashboard.ts, src/views/sessions/project-dashboard/pd-dashboard.css
import { expect, test, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";
import { conductorHistory, conductorSnapshot } from "./project-dashboard-fixtures";

// The suggestion rows above the message box (a chat's quick-reply chips, a new-chat
// draft's dashboard chips) are for an empty box: text or a pasted image hides them on
// every composer surface, emptying the box brings them back. The chat half is also
// covered in next-chips.view.spec.ts; this spec pins the draft screen and the phone.

const DESKTOP = { width: 1032, height: 900 };
const PHONE = { width: 390, height: 780 };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const draftRow = (page: Page) => page.locator("#session-pane .pd-qa-host.is-draft");
const draftChip = (page: Page) => draftRow(page).locator(".pd-chip").first();
const box = (page: Page) => page.locator("#session-pane .session-composer .composer-textarea");
const attach = (page: Page) =>
  page.locator("#session-pane .composer-file-input").setInputFiles([{ name: "shot.png", mimeType: "image/png", buffer: PNG }]);

async function mountDraft(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE, list_instances: [], get_active_sessions: [],
      dashboard_list_targets: [], dashboard_snapshot: conductorSnapshot(), dashboard_history: conductorHistory(),
      paste_attachment: "C:/tmp/pasted.png",
    },
  });
  await page.waitForFunction(() => {
    document.querySelector(".view-sessions")?.setAttribute("data-mobile-pane", "chat");
    const pane = document.querySelector<HTMLElement>("#session-pane");
    return !!pane && pane.offsetParent !== null;
  });
  await page.evaluate(async () => {
    const flow = await import("/views/sessions/pending-flow.ts");
    const pane = document.querySelector<HTMLElement>("#session-pane")!;
    await flow.launchNewSession(
      pane,
      { path: "C:/Projects/alpha", name: "Alpha" },
      { model: "claude-opus-5", effort: "high", accountId: null, characterId: null, autoAccept: true },
    );
  });
  await box(page).waitFor();
  await expect(draftChip(page)).toBeVisible();
}

for (const [label, size] of [["desktop", DESKTOP], ["phone width", PHONE]] as const) {
  test.describe(`new-chat draft chips, ${label}`, () => {
    test("typed text hides the dashboard chips and emptying the box brings them back", async ({ page }) => {
      await mountDraft(page, size);
      await box(page).pressSequentially("hi");
      await expect(draftRow(page)).toBeHidden();
      await box(page).fill("");
      await expect(draftChip(page)).toBeVisible();
    });

    test("a pasted image alone hides the chips and removing it brings them back", async ({ page }) => {
      await mountDraft(page, size);
      await attach(page);
      await page.locator("#session-pane .composer-attachments .attachment").first().waitFor();
      await expect(box(page)).toHaveValue("");
      await expect(draftRow(page)).toBeHidden();
      await page.locator("#session-pane .composer-attachments .attachment .rm").first().click();
      await expect(draftChip(page)).toBeVisible();
    });
  });
}

test.describe("chat quick-reply chips, phone width", () => {
  test("typed text hides the strip and emptying the box brings it back", async ({ page }) => {
    await page.setViewportSize(PHONE);
    const sess = sessionInstance();
    const proposal = {
      events: [
        { type: "user_message", content: [{ type: "text", text: "plan it" }], timestamp: 0, remote_echo: false, is_meta: false },
        { type: "tool_use", tool_name: "mcp__cc_conductor__send_message", input: { text: "Plan ready.", next_actions: ["Yes, implement this"] }, id: "tu-1", timestamp: 0, parent_tool_use_id: null },
      ],
      oldest_seq: 0, newest_seq: 0, has_more: false,
    };
    await mountView(page, {
      view: "sessions",
      invoke: { ...SESSIONS_BASE_INVOKE, list_instances: [sess], get_active_sessions: [sess], load_history_page: proposal },
    });
    await page.evaluate(() => document.querySelector(".view-sessions")?.setAttribute("data-mobile-pane", "list"));
    await page.locator("#sessions-list li[data-session-id]").first().click();
    await box(page).waitFor();
    const chip = page.locator("#session-pane .next-chip-slot .next-chip");
    await expect(chip.first()).toBeVisible();
    await box(page).pressSequentially("hi");
    await expect(page.locator("#session-pane .next-chip-slot")).toBeHidden();
    await box(page).fill("");
    await expect(chip.first()).toBeVisible();
  });
});
