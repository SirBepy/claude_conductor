// Reviewed 2026-11-12 (plan body): the Plan card draws a plan message's lines after its headline under it, muted; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-12 (shown badly): chat-dashboard.ts adds a contextmenu listener for the card menu's "Shown badly" item (chat-shown-badly.view.spec.ts covers it); nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-12 (honest sub states): subs gained queued/paused/usage-limit/stopped kinds with a dim ring and glyph, an avatar hover card, the Plan foot's sub counts and a glowing main-chat ring; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-12 (the /close quick-reply chip and the close-failed state are removed from the sessions list, hover card and chat chrome): nothing this spec asserts changed. It passes.
// Reviewed 2026-11-12 (per-chat previews): the Preview card lists only the previews this chat pushed (newest big, the rest as a thumbnail strip) and folds the family's others behind "N more by other chats"; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-11 (Send thread to chat): an Answers-card thread with a follow-up gains a hand-off button under its latest reply, the dashboard wires its send through sendRevision, and AnswerAuthor carries the sub's id; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-11 (phone keyboard): a chat no longer focuses its composer on open at phone width; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-11 (plan-close): chat-dashboard.css gained the `.cdash-step--left` rule only; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-11 (answers pending row): answers-model.ts adds a row per question handed to a sub (spawn_chat, read-only, report_back) until its answer fills it, and the dashboard passes the sub list only once it holds this chat; this spec has no hand-off, nothing it asserts changed, and it passes.
// Reviewed 2026-11-11 (dashboard Drafts card): a new left-column zone draws write_draft drafts, the draft card takes an optional version and Edit form, and the dashboard reads the drafts store; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-10 (question-card-ask): the Ask panel and its strip/dial entries are gone, a question card's Ask (shown only in Dashboard view) minimizes the card and opens a thread in the Answers card, and the thread classes moved from ask-* to ax-*; nothing this spec asserts changed, and it passes.
// asserts: src/views/sessions/chat-dashboard/chat-dashboard.css, src/views/sessions/chat-dashboard/chat-dashboard.ts, src/views/sessions/active-session.ts, src/views/sessions/active-session-mount.ts, src/views/sessions/pending-pane.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// The chat pane is rebuilt (innerHTML) on every chat switch and for a new-chat
// draft, but the dashboard's `data-chat-view` mark sits on the pane itself and
// outlives that rebuild. The next chat's dashboard only mounts once its
// statusbar settings read returns, and a draft never mounts one, so for that
// whole gap the old mark hid the fresh pane's transcript area with no dashboard
// beside it: the composer jumped up under the header and the rest was empty
// (Joe's report, 2026-11-10). get_settings is held here to make the gap last.

const A = sessionInstance({ session_id: "s-a", pid: 101, name: "Alpha chat" });
const B = sessionInstance({ session_id: "s-b", pid: 102, name: "Beta chat" });
const SEND = "mcp__cc_conductor__send_message";
const HISTORY = [
  { type: "user_message", content: [{ type: "text", text: "is it in?" }], timestamp: 0 },
  { type: "tool_use", tool_name: SEND, input: { kind: "answer", verdict: "Yes", text: "It is in." }, id: "t1", timestamp: 0, parent_tool_use_id: null },
  { type: "tool_result", tool_use_id: "t1", output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 },
];

type Core = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
type Probe = { __hold: boolean; __release: () => void; __worstTop: number; __sampling: boolean };

async function openDashboardChat(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 860 });
  await mountView(page, {
    view: "sessions",
    chatView: "dashboard",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [A, B],
      get_active_sessions: [A, B],
      load_history_page: { events: HISTORY, oldest_seq: 0, newest_seq: HISTORY.length, has_more: false },
      list_subchats_on: [],
      dashboard_list_targets: [],
      set_auto_accept: null,
      get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
      list_slash_commands: [],
      list_auto_accept: [],
    },
  });
  await page.locator(`#sessions-list li[data-session-id="${A.session_id}"]`).click();
  await expect(page.locator("#session-pane .cdash .cdash-answers")).toBeVisible();
  // get_settings answers at once until __hold is set, then waits for __release.
  // Every frame from then on records how high the message box sits in the pane.
  await page.evaluate(() => {
    const w = window as unknown as Probe & { __TAURI__: { core: Core } };
    w.__hold = false;
    w.__worstTop = 1;
    w.__sampling = false;
    const waiting: Array<() => void> = [];
    w.__release = () => { w.__hold = false; waiting.splice(0).forEach((go) => go()); };
    const core = w.__TAURI__.core;
    const orig = core.invoke;
    core.invoke = (cmd, args) => {
      if (cmd === "get_settings" && w.__hold) return new Promise<void>((go) => waiting.push(go)).then(() => orig(cmd, args));
      return orig(cmd, args);
    };
    const tick = (): void => {
      if (w.__sampling) {
        const pane = document.querySelector<HTMLElement>("#session-pane");
        const shell = pane?.querySelector<HTMLElement>(".composer-shell");
        if (pane && shell) {
          const p = pane.getBoundingClientRect();
          const top = (shell.getBoundingClientRect().top - p.top) / p.height;
          w.__worstTop = Math.min(w.__worstTop, top);
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const startHold = (page: Page) => page.evaluate(() => {
  const w = window as unknown as Probe;
  w.__hold = true;
  w.__sampling = true;
});
const release = (page: Page) => page.evaluate(() => (window as unknown as Probe).__release());
const worstTop = (page: Page) => page.evaluate(() => (window as unknown as Probe).__worstTop);

/** The message box sits in the lower part of the pane, below a visible area. */
async function expectComposerAtBottom(page: Page): Promise<void> {
  const pane = (await page.locator("#session-pane").boundingBox())!;
  const shell = (await page.locator("#session-pane .composer-shell").boundingBox())!;
  expect(shell.y + shell.height).toBeGreaterThan(pane.y + pane.height - 40);
}

test.describe("chat dashboard / a rebuilt pane", () => {
  test("switching chats keeps the message box at the bottom before the next dashboard mounts", async ({ page }) => {
    await openDashboardChat(page);
    await startHold(page);
    await page.locator(`#sessions-list li[data-session-id="${B.session_id}"]`).click();
    await expect(page.locator("#session-pane .session-header")).toContainText("Beta chat");
    // Still waiting on settings: no dashboard yet, and the fresh pane's own
    // transcript area must be what holds the space.
    await expect(page.locator("#session-pane .cdash")).toHaveCount(0);
    await expect(page.locator("#session-pane .session-messages")).toBeVisible();
    await expectComposerAtBottom(page);
    await capture(page.locator("#session-pane"), "chat-dashboard-switch-gap");

    await release(page);
    await expect(page.locator("#session-pane .cdash .cdash-answers")).toBeVisible();
    await expect(page.locator("#session-pane .session-messages")).toBeHidden();
    await expectComposerAtBottom(page);
    expect(await worstTop(page)).toBeGreaterThan(0.5);
  });

  test("switching back to a retained chat keeps the message box at the bottom", async ({ page }) => {
    await openDashboardChat(page);
    await page.locator(`#sessions-list li[data-session-id="${B.session_id}"]`).click();
    await expect(page.locator("#session-pane .session-header")).toContainText("Beta chat");
    await expect(page.locator("#session-pane .cdash .cdash-answers")).toBeVisible();

    await startHold(page);
    await page.locator(`#sessions-list li[data-session-id="${A.session_id}"]`).click();
    await expect(page.locator("#session-pane .session-header")).toContainText("Alpha chat");
    await expect(page.locator("#session-pane .session-messages")).toBeVisible();
    await expectComposerAtBottom(page);

    await release(page);
    await expect(page.locator("#session-pane .cdash .cdash-answers")).toBeVisible();
    await expectComposerAtBottom(page);
    expect(await worstTop(page)).toBeGreaterThan(0.5);
  });

  test("a new-chat draft opened from a dashboard chat shows its own pane, not a bare composer", async ({ page }) => {
    await openDashboardChat(page);
    await page.waitForFunction(() => typeof (window as unknown as { __launchDraftForTest?: unknown }).__launchDraftForTest === "function");
    await page.evaluate(() => { (window as unknown as Probe).__sampling = true; });
    await page.evaluate(() => (window as unknown as { __launchDraftForTest: (p: unknown, c: unknown) => void })
      .__launchDraftForTest({ path: "C:/Projects/alpha", name: "alpha" }, { model: "sonnet", effort: "low", accountId: "acc1" }));
    await page.locator("#session-pane .session-composer .composer-textarea").waitFor();
    // A draft never mounts the chat dashboard, so the old chat's mark must not
    // hide the draft's transcript area (where its project dashboard lives).
    await expect(page.locator("#session-pane .cdash")).toHaveCount(0);
    await expect(page.locator("#session-pane .session-messages")).toBeVisible();
    await expectComposerAtBottom(page);
    await capture(page.locator("#session-pane"), "chat-dashboard-draft-after-dashboard");
    expect(await worstTop(page)).toBeGreaterThan(0.5);
  });
});
