// asserts: src/views/sessions/permission-modal/index.ts, src/views/sessions/permission-modal/question-submit.ts, src/views/sessions/permission-modal/gating.ts, src/views/sessions/permission-modal/askers.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, fireEvent, invokeCalls, mountView, mountViewPhone, SESSIONS_BASE_INVOKE, sessionInstance, waitForPaneSettled } from "./harness";

// Subchats step 3: a hidden sub asks, Joe answers in the main chat's window.
// Drives the real sessions view, sidebar, gate and card at desktop and phone
// width. The daemon stamps each prompt with `display_session_id` (the main
// chat) while `session_id` stays the asker, the answer target.

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 393, height: 852 };

const SESSIONS = [
  sessionInstance({ session_id: "main", name: "CV redesign", pid: 101 }),
  sessionInstance({ session_id: "sub-a", name: "Review session code", pid: 102, subchat_of: "main" }),
  sessionInstance({ session_id: "sub-b", name: "Fix login test", pid: 103, subchat_of: "main" }),
  sessionInstance({ session_id: "sub-c", name: "Update docs", pid: 104, subchat_of: "main" }),
  sessionInstance({ session_id: "solo", name: "Solo chat", pid: 105 }),
  sessionInstance({ session_id: "worker", name: "Jarvis worker", pid: 106, worker_of: "jarvis" }),
];

const q = (n: number) => ({ question: `Question ${n}?`, header: `Q${n}`, options: [{ label: "Yes" }, { label: "No" }] });
const questions = (count: number) => Array.from({ length: count }, (_, i) => q(i + 1));

let seq = 0;
const subPrompt = (sub: string, count: number, over: Record<string, unknown> = {}) => ({
  id: `prompt-${sub}`, session_id: sub, display_session_id: "main", seq: ++seq,
  sub_name: SESSIONS.find((s) => s.session_id === sub)!.name, sub_task: `Job of ${sub}`,
  questions: questions(count), ...over,
});
const ownPrompt = (session: string, count: number, over: Record<string, unknown> = {}) => ({
  id: `prompt-${session}`, session_id: session, seq: ++seq, questions: questions(count), ...over,
});

async function mount(page: Page, size: { width: number; height: number }, pending: unknown[] = []): Promise<void> {
  await page.setViewportSize(size);
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: SESSIONS,
      get_active_sessions: SESSIONS,
      list_pending_prompts: pending.map((p) => ({ id: (p as { id: string }).id, event: "question-requested", durable: true, payload: p })),
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
  // The phone shows the chat pane OR the list, never both: go back to the list
  // first so a second chat can be picked (CSS only acts on this attribute at <=768px).
  await page.evaluate(() => document.querySelector(".view-sessions")?.setAttribute("data-mobile-pane", "list"));
  await page.locator(`#sessions-list li[data-session-id="${id}"]`).click();
  await page.locator("#session-pane .session-composer").waitFor();
  await waitForPaneSettled(page);
}

const card = (page: Page) => page.locator(".prompt-card");
const chips = (page: Page) => page.locator(".prompt-askers .prompt-asker");
const chipNames = (page: Page) => chips(page).locator(".prompt-asker__name").allTextContents();
const chipCounts = (page: Page) => chips(page).locator(".prompt-asker__count").allTextContents();

async function calls(page: Page, cmd: string): Promise<Array<Record<string, unknown>>> {
  return (await invokeCalls(page)).filter((c) => c.cmd === cmd).map((c) => (c.args ?? {}) as Record<string, unknown>);
}

test.describe("view-harness / sub question routing (phone transport)", () => {
  // The phone has no Tauri event bus: it polls list_pending_prompts over the remote RPC,
  // so this is the path a paired phone's card actually takes.
  test("polled prompts show on the main chat with chips and the answer goes to the sub", async ({ page }) => {
    const asks = [subPrompt("sub-a", 1), subPrompt("sub-b", 2)];
    // A phone send is a POST to the REST route, not an rpc call.
    const sends: string[] = [];
    await page.route("**/api/sessions/*/send", async (route) => {
      sends.push(decodeURIComponent(new URL(route.request().url()).pathname.split("/")[3]!));
      await route.fulfill({ status: 200, body: "" });
    });
    await page.setViewportSize(PHONE);
    await mountViewPhone(page, {
      view: "sessions",
      invoke: {
        ...SESSIONS_BASE_INVOKE,
        list_instances: SESSIONS,
        get_active_sessions: SESSIONS,
        list_pending_prompts: asks.map((p) => ({ id: p.id, event: "question-requested", durable: true, payload: p })),
        get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
        load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
        respond_question: false,
        send_message: null,
        confirm_question_rendered: null,
      },
    });
    await page.locator("#sessions-list li[data-session-id]").first().waitFor();
    // Parked from the poll while Joe is on the list: the main chat's row is marked, the sub's card waits there.
    await expect(page.locator('#sessions-list li[data-session-id="main"]')).toHaveAttribute("data-st", "st-attention");
    await openChat(page, "main");
    await expect(card(page)).toHaveCount(1);
    await expect(chips(page)).toHaveCount(2);
    expect(await chipNames(page)).toEqual(["Review session code", "Fix login test"]);
    await card(page).locator('.prompt-opt input[data-label="Yes"]').click();
    await card(page).locator(".prompt-answer-send").click();
    await expect.poll(() => sends.length).toBe(1);
    expect(sends).toEqual(["sub-a"]);
  });
});

for (const [label, size] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test.describe(`view-harness / sub question routing (${label})`, () => {
    test("a sub's question shows on the main chat with its name, task and a chip once two chats ask", async ({ page }) => {
      await mount(page, size);
      await openChat(page, "main");
      await fireEvent(page, "question-requested", [subPrompt("sub-a", 3)]);
      await expect(card(page)).toHaveCount(1);
      // One asker: its name in the header, its job under it, no picker.
      await expect(card(page).locator(".prompt-from")).toContainText("Review session code");
      await expect(card(page).locator(".prompt-from-task")).toHaveText("Job of sub-a");
      await expect(chips(page)).toHaveCount(0);

      await fireEvent(page, "question-requested", [subPrompt("sub-b", 1)]);
      await expect(chips(page)).toHaveCount(2);
      // The picker names every asker, so the header chip yields to it.
      await expect(card(page).locator(".prompt-card__header .prompt-from")).toHaveCount(0);
      expect(await chipNames(page)).toEqual(["Fix login test", "Review session code"]);
      expect(await chipCounts(page)).toEqual(["1", "3"]);
      await expect(chips(page).nth(1)).toHaveClass(/is-active/);
      // The dev-build marker strip sits over the card's top row on the phone, where the real app has none.
      await page.evaluate(() => document.getElementById("test-build-banner")?.remove());
      await capture(page, `subchat-card-chips-${label}`);
    });

    test("the main chat's own question is one of the chips", async ({ page }) => {
      await mount(page, size);
      await openChat(page, "main");
      await fireEvent(page, "question-requested", [ownPrompt("main", 2), subPrompt("sub-a", 1)]);
      await expect(chips(page)).toHaveCount(2);
      expect(await chipNames(page)).toEqual(["Review session code", "This chat"]);
    });

    test("switching chips keeps a half-answered card's draft", async ({ page }) => {
      await mount(page, size);
      await openChat(page, "main");
      await fireEvent(page, "question-requested", [subPrompt("sub-a", 3), subPrompt("sub-b", 1)]);
      await expect(chips(page)).toHaveCount(2);
      // sub-a's card is up (it arrived first). Answer its first question.
      await card(page).locator('.prompt-panel[data-panel="0"] input[data-label="Yes"]').click();
      await expect(card(page).locator('.prompt-panel[data-panel="0"] input[data-label="Yes"]')).toBeChecked();

      await chips(page).filter({ hasText: "Fix login test" }).click();
      await expect(chips(page).filter({ hasText: "Fix login test" })).toHaveClass(/is-active/);
      await expect(card(page).locator(".prompt-panel")).toHaveCount(1);

      await chips(page).filter({ hasText: "Review session code" }).click();
      await expect(card(page).locator(".prompt-panel")).toHaveCount(4);
      await expect(card(page).locator('.prompt-panel[data-panel="0"] input[data-label="Yes"]')).toBeChecked();
    });

    test("chips are fewest first and do not reshuffle as more arrive", async ({ page }) => {
      await mount(page, size);
      await openChat(page, "main");
      await fireEvent(page, "question-requested", [subPrompt("sub-a", 3), subPrompt("sub-b", 2)]);
      expect(await chipNames(page)).toEqual(["Fix login test", "Review session code"]);
      await fireEvent(page, "question-requested", [subPrompt("sub-c", 1)]);
      expect(await chipNames(page)).toEqual(["Update docs", "Fix login test", "Review session code"]);
      // A second card from sub-b raises its count past sub-a's; the chips stay put.
      await fireEvent(page, "question-requested", [subPrompt("sub-b", 4, { id: "prompt-sub-b-2" })]);
      expect(await chipNames(page)).toEqual(["Update docs", "Fix login test", "Review session code"]);
      expect(await chipCounts(page)).toEqual(["1", "6", "3"]);
    });

    test("answering goes to the sub, never the main chat, and the next asker's card slides in", async ({ page }) => {
      const asks = [subPrompt("sub-a", 1), subPrompt("sub-b", 2)];
      await mount(page, size, asks);
      await openChat(page, "main");
      await fireEvent(page, "question-requested", asks);
      await expect(chips(page)).toHaveCount(2);
      await card(page).locator('.prompt-opt input[data-label="Yes"]').click();
      await card(page).locator(".prompt-answer-send").click();

      await expect.poll(async () => (await calls(page, "send_message")).length).toBe(1);
      const sends = await calls(page, "send_message");
      expect(sends[0]!.sessionId).toBe("sub-a");
      expect((await calls(page, "respond_question"))[0]).toMatchObject({ id: "prompt-sub-a", sessionId: "sub-a", skipped: false });
      expect(sends.some((s) => s.sessionId === "main")).toBe(false);
      // The other sub's two-question card is up now, with nobody left to pick between.
      await expect(card(page).locator(".prompt-panel")).toHaveCount(3);
      await expect(chips(page)).toHaveCount(0);
    });

    test("Skip on a sub's card tells the sub in the exact words; a normal chat's Skip is silent", async ({ page }) => {
      await mount(page, size);
      await openChat(page, "main");
      await fireEvent(page, "question-requested", [subPrompt("sub-a", 1)]);
      await card(page).locator('[data-act="minimize"]').click();
      await page.locator(".prompt-collapsed__skip").click();
      await expect.poll(async () => (await calls(page, "send_message")).length).toBe(1);
      const sends = await calls(page, "send_message");
      expect(sends[0]!.sessionId).toBe("sub-a");
      expect(sends[0]!.blocks).toEqual([{
        type: "text",
        text: "Joe skipped this. Pick the safest default, or finish and report it as blocked.",
      }]);
      expect((await calls(page, "respond_question"))[0]).toMatchObject({ id: "prompt-sub-a", skipped: true });

      await openChat(page, "solo");
      await fireEvent(page, "question-requested", [ownPrompt("solo", 1)]);
      await card(page).locator('[data-act="minimize"]').click();
      await page.locator(".prompt-collapsed__skip").click();
      await expect.poll(async () => (await calls(page, "respond_question")).length).toBe(2);
      expect((await calls(page, "send_message")).length).toBe(1);
    });

    test("a sub's permission prompt shows on a main chat that has auto-accept on and is not auto-approved", async ({ page }) => {
      await mount(page, size);
      await openChat(page, "main");
      await page.evaluate(async () => {
        const qm = await import("/views/sessions/permission-modal/index.ts");
        qm.setAutoAccept("main", true);
      });
      const perm = (session: string, id: string, extra: Record<string, unknown>) => ({
        id, tool_name: "Bash", input: { command: "ls" }, session_id: session, ...extra,
      });
      // Control: the main chat's own prompt IS auto-allowed, so auto-accept is really on.
      await fireEvent(page, "permission-requested", [perm("main", "perm-main", {})]);
      await expect.poll(async () => (await calls(page, "respond_permission")).length).toBe(1);
      expect((await calls(page, "respond_permission"))[0]).toMatchObject({ id: "perm-main", behavior: "allow" });

      await fireEvent(page, "permission-requested", [perm("sub-a", "perm-sub", { display_session_id: "main", sub_name: "Review session code" })]);
      await expect(card(page)).toHaveCount(1);
      await expect(card(page).locator(".prompt-card__title")).toContainText("Permission requested");
      await expect(card(page).locator(".prompt-from")).toContainText("Review session code");
      expect((await calls(page, "respond_permission")).length).toBe(1);
    });

    test("a sub's question parked while Joe is elsewhere marks the main chat's row, and opening it shows the card", async ({ page }) => {
      const pending = subPrompt("sub-a", 2);
      await mount(page, size, [pending]);
      await openChat(page, "solo");
      await fireEvent(page, "question-requested", [pending]);
      await expect(card(page)).toHaveCount(0);
      await expect(page.locator('#sessions-list li[data-session-id="main"]')).toHaveAttribute("data-st", "st-attention");
      await expect(page.locator('#sessions-list li[data-session-id="solo"]')).not.toHaveAttribute("data-st", "st-attention");

      // The sub had no daemon-side delivery problem: the park was acknowledged.
      expect((await calls(page, "confirm_question_rendered"))[0]).toMatchObject({ id: "prompt-sub-a", sessionId: "sub-a" });
      await openChat(page, "main");
      await expect(card(page)).toHaveCount(1);
      await expect(card(page).locator(".prompt-from")).toContainText("Review session code");
    });

    test("regression: a normal chat's and a Jarvis worker's question behave as they always did", async ({ page }) => {
      const workerPrompt = ownPrompt("worker", 1);
      await mount(page, size, [ownPrompt("solo", 2), workerPrompt]);
      await openChat(page, "main");
      await fireEvent(page, "question-requested", [ownPrompt("solo", 2), workerPrompt]);
      // Neither asked on the chat on screen, so neither shows here and neither is a sub.
      await expect(card(page)).toHaveCount(0);
      await expect(page.locator('#sessions-list li[data-session-id="solo"]')).toHaveAttribute("data-st", "st-attention");
      await expect(page.locator('#sessions-list li[data-session-id="main"]')).not.toHaveAttribute("data-st", "st-attention");

      await openChat(page, "solo");
      await expect(card(page)).toHaveCount(1);
      await expect(card(page).locator(".prompt-from, .prompt-from-task")).toHaveCount(0);
      await expect(chips(page)).toHaveCount(0);
      await expect(card(page).locator(".prompt-panel")).toHaveCount(3);
    });
  });
}
