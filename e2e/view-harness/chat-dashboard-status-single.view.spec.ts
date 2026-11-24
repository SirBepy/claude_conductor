// Reviewed 2026-11-24 (main chat Plan card trimmed to the header and the lines, merged card always drawn, Done card always open): nothing this spec asserts changed, and it passes in the run of every dependent spec.
// Reviewed 2026-11-23 (Done card on a main chat): a main chat's finished features are now drawn as Done lines by done-lines-card.ts, and the Done zone draws a constant host for them; nothing this spec asserts changed, and it passes in the run of every dependent spec.
// Reviewed 2026-11-23 (Plan card follow-ups): a main chat counts as a main chat only while a sub has not finished (so an all-finished chat keeps its Attachments card), and the Plan card keeps the chat Joe is writing to only while its box has text or focus; nothing this spec asserts changed, and it passes (run of every dependent spec).
// Reviewed 2026-11-23 (merged Plan card): a main chat's Plan card now lists its subs as feature lines and drops the Subchats and Attachments cards, and SubCardItem gained a steps list; nothing this spec asserts changed, and it passes in the run of every dependent spec.
// Reviewed 2026-11-21 (Run card and opened sub view tabs): chat-dashboard.ts, dashboard-zones.ts, dashboard-extras.css and subs-card.ts changed for the Run card's after names and the sub view's Plan and Attachments tabs; nothing this spec asserts changed, and it passes (run of every dependent spec).
// Reviewed 2026-11-21 (bottom edge): .cdash-body trades its 18px bottom padding for a 24px sticky ::after that fades into the message box; nothing this spec asserts changed, and it passes (run of every dependent spec).
// asserts: src/views/sessions/chat-dashboard/chat-dashboard.ts, src/views/sessions/chat-dashboard/plan-card.ts, src/views/sessions/chat-dashboard/chat-dashboard.css, src/views/sessions/session-thinking-bar.ts
import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// One status indicator at a time. In Dashboard view the chat's status line (the
// "Running: ..., 0:15" bar) shows in the Plan card's foot, or above the message
// box when held messages pin it there, and the foot's own resting "Idle since"
// line must never be up beside it. Joe saw both at once (2026-11-18): the foot
// said "This chat idle since 12:32 am" while the bar above the composer ran.

const SESSION = sessionInstance();
const STAMP = "2026-11-18T10:00:00Z";
const user = (text: string) => ({ type: "user_message", content: [{ type: "text", text }], timestamp: 0 });
const HISTORY: unknown[] = [user("check the old folder")];

async function openChat(page: Page, session = SESSION, extra: Record<string, unknown> = {}): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 860 });
  await mountView(page, {
    view: "sessions",
    chatView: "dashboard",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [session],
      get_active_sessions: [session],
      load_history_page: { events: HISTORY, oldest_seq: 0, newest_seq: HISTORY.length, has_more: false },
      get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
      add_held_message: { id: 1, updated_at: STAMP },
      update_held_message: { updated_at: STAMP },
      remove_held_message: { updated_at: STAMP },
      clear_held_messages: { updated_at: STAMP },
      set_composer_draft: { updated_at: STAMP },
      clear_composer_draft: { updated_at: STAMP },
      ...extra,
    },
  });
  await page.locator(`#sessions-list li[data-session-id="${SESSION.session_id}"]`).click();
  await expect(page.locator("#session-pane .cdash")).toBeVisible();
}

const bar = (page: Page) => page.locator("#session-pane .session-thinking");
const foot = (page: Page) => page.locator("#session-pane .cdash-plan .cdash-pstatus");
const setBusy = (page: Page, busy: boolean) =>
  page.evaluate(([id, b]) => (window as unknown as { __setBusy: (i: string, b: boolean) => void }).__setBusy(id as string, b as boolean), [SESSION.session_id, busy] as const);

test.describe("dashboard status line: one place at a time", () => {
  test("idle, then a turn starts: the foot's idle line gives way to the status line", async ({ page }) => {
    await openChat(page, sessionInstance({ busy: false, awaiting: null }));
    await expect(foot(page)).toBeVisible();
    await expect(bar(page)).toBeHidden();

    await setBusy(page, true);
    await expect(page.locator("#session-pane .cdash-plan [data-slot='status'] .session-thinking")).toBeVisible();
    await expect(foot(page)).toHaveCount(0);

    await setBusy(page, false);
    await expect(foot(page)).toBeVisible();
    await expect(bar(page)).toBeHidden();
  });

  test("a message sent mid-turn is held: the foot does not claim the chat is idle while the line runs", async ({ page }) => {
    await openChat(page, sessionInstance({ busy: true, awaiting: null }));
    const box = page.locator("#session-pane .session-composer .composer-textarea");
    await box.fill("and the config files");
    await box.press("Enter");
    await expect(page.locator("#session-pane .held-count")).toHaveText("1");
    // The held list opens out of the line, so the line waits above the message box.
    await expect(page.locator("#session-pane .composer-shell > .session-thinking")).toBeVisible();
    await expect(foot(page)).toHaveCount(0);
    await expect(page.locator("#session-pane .cdash-plan")).not.toContainText(/idle since/i);
  });

  test("with subs, a held message does not bring back the subs foot beside the line", async ({ page }) => {
    const sub = sessionInstance({ session_id: "sub-1", name: "A sub", subchat_of: SESSION.session_id, busy: true, awaiting: null } as never);
    await openChat(page, sessionInstance({ busy: true, awaiting: null }), { list_instances: [sessionInstance({ busy: true, awaiting: null }), sub] });
    const box = page.locator("#session-pane .session-composer .composer-textarea");
    await box.fill("one more thing");
    await box.press("Enter");
    await expect(page.locator("#session-pane .held-count")).toHaveText("1");
    // Anchor on the dashboard's own re-render (the line moved above the box) before the negative.
    await expect(page.locator("#session-pane .composer-shell > .session-thinking")).toBeVisible();
    await expect(page.locator("#session-pane .cdash-plan .cdash-pstatus")).toHaveCount(0);
    // One running line in the whole pane: the held list brought no second status line back.
    await expect(page.locator("#session-pane .session-thinking:visible")).toHaveCount(1);
  });

  test("held messages on a chat that is not running keep the foot's own line (the bar only says Waiting to send)", async ({ page }) => {
    await openChat(page, sessionInstance({ busy: true, awaiting: null }));
    const box = page.locator("#session-pane .session-composer .composer-textarea");
    await box.fill("queued while it ran");
    await box.press("Enter");
    await expect(page.locator("#session-pane .held-count")).toHaveText("1");
    // The turn ended on a question: nothing flushes, the held message stays queued.
    await page.evaluate(async (id) => {
      const sm = await import("/views/sessions/state.ts");
      const inst = sm.state.sessions.find((s) => s.session_id === id);
      if (inst) inst.awaiting = "question";
      (window as unknown as { __setBusy: (i: string, b: boolean) => void }).__setBusy(id, false);
    }, SESSION.session_id);
    await expect(page.locator("#session-pane .composer-shell > .session-thinking .thinking-text")).toHaveText("Waiting to send");
    await expect(foot(page)).toBeVisible();
    await expect(foot(page)).toContainText(/idle/i);
  });

  test("on an earlier plan with a message held, the foot still says how to get back", async ({ page }) => {
    const plan = (id: string, label: string) => [
      { type: "tool_use", tool_name: "mcp__cc_conductor__write_plan", input: { steps: [{ text: label, status: "done" }] }, id, timestamp: 0, parent_tool_use_id: null },
      { type: "tool_result", tool_use_id: id, output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 },
    ];
    HISTORY.splice(0, HISTORY.length, user("first job"), ...plan("p1", "Read the folder"), user("second job"), ...plan("p2", "Check the config"));
    await openChat(page, sessionInstance({ busy: true, awaiting: null }));
    const box = page.locator("#session-pane .session-composer .composer-textarea");
    await box.fill("hold this");
    await box.press("Enter");
    await expect(page.locator("#session-pane .held-count")).toHaveText("1");
    await page.locator("#session-pane .cdash-plan [data-act='plan-prev']").click();
    const away = page.locator("#session-pane .cdash-plan .cdash-status.is-away");
    await expect(away).toBeVisible();
    await expect(page.locator("#session-pane .composer-shell > .session-thinking")).toBeVisible();
    // Not an empty, label-less button: the foot says what a click does.
    expect(await away.evaluate((el) => getComputedStyle(el, "::before").content)).toBe('"Back to the current plan"');
    expect((await away.boundingBox())!.height).toBeGreaterThan(20);
  });

  test("Messages view keeps the line above the message box", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    const busy = sessionInstance({ busy: true, awaiting: null });
    await mountView(page, {
      view: "sessions",
      chatView: "messages",
      invoke: { ...SESSIONS_BASE_INVOKE, list_instances: [busy], get_active_sessions: [busy], load_history_page: { events: HISTORY, oldest_seq: 0, newest_seq: 1, has_more: false } },
    });
    await page.locator(`#sessions-list li[data-session-id="${SESSION.session_id}"]`).click();
    await expect(page.locator("#session-pane .composer-shell > .session-thinking")).toBeVisible();
    await expect(page.locator("#session-pane .cdash")).toHaveCount(0);
  });
});
