// asserts: src/views/sessions/permission-modal/asker-face.ts, src/views/sessions/permission-modal/question-ui-templates.ts, src/views/sessions/permission-modal/question-ui-render.ts, src/views/sessions/permission-modal/permission-card.ts, src/views/sessions/permission-modal/secret-card.ts, src/views/sessions/permission-modal/askers.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, fireEvent, mountView, SESSIONS_BASE_INVOKE, sessionInstance, waitForPaneSettled } from "./harness";

// C5 (docs/chat-dashboard-design.md): every card names who asks. A sub is drawn as
// its avatar (initials, ring, model battery) and name, also when it is the only
// asker; the main chat's own card says "Main chat"; a card the daemon raises about
// a sub names that sub. A plain chat's card names nobody.

const SESSIONS = [
  sessionInstance({ session_id: "main", name: "CV redesign", pid: 101 }),
  sessionInstance({ session_id: "sub-a", name: "Review session code", pid: 102, subchat_of: "main", model: "claude-sonnet-4-5", effort: "high" }),
  sessionInstance({ session_id: "sub-b", name: "Fix login test", pid: 103, subchat_of: "main" }),
  sessionInstance({ session_id: "solo", name: "Solo chat", pid: 105 }),
];

const questions = [{ question: "Which one?", header: "Pick", options: [{ label: "Yes" }, { label: "No" }] }];
let seq = 0;
const subPrompt = (sub: string) => ({
  id: `prompt-${sub}`, session_id: sub, display_session_id: "main", seq: ++seq,
  sub_name: SESSIONS.find((s) => s.session_id === sub)!.name, questions,
});
const ownPrompt = (session: string) => ({ id: `prompt-${session}`, session_id: session, seq: ++seq, questions });
/** What `cards::raise_card` stamps: shown in the main chat's window, about a sub. */
const daemonCard = (over: Record<string, unknown> = {}) => ({
  id: "card-stuck", session_id: "main", display_session_id: "main", daemon_card: true, card_kind: "subchat_stuck",
  sub_id: "sub-a", sub_name: "Review session code", seq: ++seq, questions, ...over,
});

async function mount(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: SESSIONS,
      get_active_sessions: SESSIONS,
      // "main" has Use subchats on: that is what makes it a main chat.
      list_subchats_on: ["main"],
      get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
      respond_question: false,
      respond_permission: null,
      send_message: null,
      confirm_question_rendered: null,
      list_auto_accept: [],
      set_auto_accept: null,
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().waitFor();
}

async function openChat(page: Page, id: string): Promise<void> {
  await page.locator(`#sessions-list li[data-session-id="${id}"]`).click();
  await page.locator("#session-pane .session-composer").waitFor();
  await waitForPaneSettled(page);
}

const card = (page: Page) => page.locator(".prompt-card");
const header = (page: Page) => card(page).locator(".prompt-card__header");

test.describe("view-harness / who a card says it comes from", () => {
  test("a sub that is the only asker shows its avatar (initials, ring, battery) and name", async ({ page }) => {
    await mount(page);
    await openChat(page, "main");
    await fireEvent(page, "question-requested", [subPrompt("sub-a")]);
    const chip = header(page).locator(".prompt-from--sub");
    await expect(chip).toHaveCount(1);
    await expect(chip.locator(".prompt-from__face")).toContainText("RS");
    await expect(chip.locator(".prompt-from__face svg.avatar-ring")).toHaveCount(1);
    await expect(chip.locator(".session-model-battery")).toHaveCount(1);
    await expect(chip.locator(".prompt-from__name")).toHaveText("Review session code");
    // The avatar is drawn: the face has a real size, not a collapsed span.
    const face = await chip.locator(".prompt-from__face").boundingBox();
    expect(face!.width).toBeGreaterThanOrEqual(18);
    await page.waitForTimeout(700); // the card rises in; a shot mid-animation is washed out
    await capture(card(page), "card-asker-chip-lone-sub");
  });

  test("the main chat's own question says Main chat", async ({ page }) => {
    await mount(page);
    await openChat(page, "main");
    await fireEvent(page, "question-requested", [ownPrompt("main")]);
    const chip = header(page).locator(".prompt-from--main");
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveText("Main chat");
    await expect(header(page).locator(".prompt-from--sub")).toHaveCount(0);
    await page.waitForTimeout(700);
    await capture(card(page), "card-asker-chip-main-chat");
  });

  test("a plain chat's card names nobody", async ({ page }) => {
    await mount(page);
    await openChat(page, "solo");
    await fireEvent(page, "question-requested", [ownPrompt("solo")]);
    await expect(card(page)).toHaveCount(1);
    await expect(card(page).locator(".prompt-from")).toHaveCount(0);
  });

  test("the main chat's permission prompt says Main chat, and a sub's shows its avatar", async ({ page }) => {
    await mount(page);
    await openChat(page, "main");
    await fireEvent(page, "permission-requested", [
      { id: "perm-main", tool_name: "Bash", input: { command: "ls" }, session_id: "main" },
    ]);
    await expect(header(page).locator(".prompt-from--main")).toHaveText("Main chat");
    await page.locator('[data-act="deny"]').click();

    await fireEvent(page, "permission-requested", [
      { id: "perm-sub", tool_name: "Bash", input: { command: "ls" }, session_id: "sub-b", display_session_id: "main", sub_name: "Fix login test" },
    ]);
    await expect(header(page).locator(".prompt-from--sub .prompt-from__face")).toContainText("FL");
    await expect(header(page).locator(".prompt-from--sub .prompt-from__name")).toHaveText("Fix login test");
  });

  test("the secret card shows a sub's avatar, and Main chat on the main chat's own", async ({ page }) => {
    await mount(page);
    await openChat(page, "main");
    await page.evaluate(async () => {
      const mod = await import("/views/sessions/permission-modal/secret-card.ts");
      mod.showSecretCard({
        id: "secret-sub", session_id: "sub-a", display_session_id: "main", sub_name: "Review session code",
        label: "x", file: "C:\\repo\\.env", key: "API_KEY",
      });
    });
    await expect(header(page).locator(".prompt-from--sub .prompt-from__face")).toContainText("RS");
    await expect(header(page).locator(".secret-card__from")).toContainText("Review session code");
    await page.evaluate(async () => {
      const mod = await import("/views/sessions/permission-modal/secret-card.ts");
      mod.dismissSecretCard("secret-sub");
      mod.showSecretCard({ id: "secret-main", session_id: "main", label: "x", file: "C:\\repo\\.env", key: "API_KEY" });
    });
    await expect(header(page).locator(".prompt-from--main")).toHaveText("Main chat");
  });

  test("a card the daemon raises about a sub names that sub, and says nothing when it is about no sub", async ({ page }) => {
    await mount(page);
    await openChat(page, "main");
    await fireEvent(page, "question-requested", [daemonCard()]);
    const chip = header(page).locator(".prompt-from--sub");
    await expect(chip).toHaveCount(1);
    await expect(chip.locator(".prompt-from__name")).toHaveText("Review session code");
    await expect(chip.locator(".prompt-from__face")).toContainText("RS");
    await expect(header(page).locator(".prompt-from--main")).toHaveCount(0);
    await page.waitForTimeout(700);
    await capture(card(page), "card-asker-chip-daemon-card");

    // Without a daemon-sent name the sub's own row supplies it.
    await fireEvent(page, "prompt-resolved", [{ id: "card-stuck", durable: true }]);
    await fireEvent(page, "question-requested", [daemonCard({ id: "card-row", sub_name: undefined, sub_id: "sub-b" })]);
    await expect(header(page).locator(".prompt-from--sub .prompt-from__name")).toHaveText("Fix login test");

    // A close approval is about the main chat's window, not one sub: no chip.
    await fireEvent(page, "prompt-resolved", [{ id: "card-row", durable: true }]);
    await fireEvent(page, "question-requested", [daemonCard({ id: "card-close", sub_id: undefined, sub_name: undefined, card_kind: "close_approval" })]);
    await expect(card(page)).toHaveCount(1);
    await expect(card(page).locator(".prompt-from")).toHaveCount(0);
  });

  test("with two askers the picker names them, the main chat's chip reading Main chat", async ({ page }) => {
    await mount(page);
    await openChat(page, "main");
    await fireEvent(page, "question-requested", [ownPrompt("main"), subPrompt("sub-a")]);
    await expect(card(page).locator(".prompt-askers .prompt-asker")).toHaveCount(2);
    await expect(card(page).locator(".prompt-asker__name").filter({ hasText: "Main chat" })).toHaveCount(1);
    await expect(header(page).locator(".prompt-from")).toHaveCount(0);
  });
});
