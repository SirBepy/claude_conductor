// asserts: src/views/sessions/chat-dashboard/answers-card.ts, src/views/sessions/chat-dashboard/answers-card.css, src/views/sessions/chat-dashboard/answers-api.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// A follow-up that fails after Joe left its thread marks the Answers card's thread button with
// a red dot (`replyBtn` in answers-card.ts); the dot clears once he opens the thread and
// leaves it.

const SESSION = sessionInstance();
const CHANNEL = `chat:${SESSION.session_id}`;
const SEND = "mcp__cc_conductor__send_message";

const tool = (tool_name: string, input: Record<string, unknown>, id: string) => [
  { type: "tool_use", tool_name, input, id, timestamp: 1_762_783_260, parent_tool_use_id: null },
  { type: "tool_result", tool_use_id: id, output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 },
];
const HISTORY = [
  { type: "user_message", content: [{ type: "text", text: "is the cap soft?" }], timestamp: 0 },
  ...tool(SEND, { kind: "answer", verdict: "Yes, it is soft", question: "Is the cap of 10 subs soft?", text: "A queued sub that starts later does not re-check it." }, "a1"),
  ...tool("mcp__cc_conductor__report_turn_status", { status: "done" }, "t2"),
];
const STORE = { read: {}, threads: {}, questions: [] };

async function openChat(page: Page) {
  await page.setViewportSize({ width: 1100, height: 820 });
  await mountView(page, {
    view: "sessions",
    chatView: "dashboard",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      load_history_page: { events: HISTORY, oldest_seq: 0, newest_seq: HISTORY.length, has_more: false },
      answers_state: STORE,
      ask_list_threads: [],
      answers_mark: STORE,
      answers_thread_prewarm: { ok: true },
    },
  });
  await page.locator(`#sessions-list li[data-session-id="${SESSION.session_id}"]`).click();
  await page.waitForFunction((name) => {
    const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
    return (w.__ccListeners?.get(name)?.size ?? 0) > 0;
  }, CHANNEL);
  // The send stays open until the spec fails it, like a reply that never comes.
  await page.evaluate(() => {
    const w = window as unknown as {
      __TAURI__: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
      __fail?: () => void;
    };
    const inner = w.__TAURI__.core.invoke;
    w.__TAURI__.core.invoke = (cmd, args) => {
      if (cmd !== "answers_thread_send") return inner(cmd, args);
      return new Promise((_, rej) => {
        w.__fail = () => rej(new Error("the Claude process closed before it replied"));
      });
    };
  });
  return page.locator("#session-pane .cdash-answers");
}

test("a follow-up that fails after Joe left the thread marks the thread button with a red dot until he has seen the error", async ({ page }) => {
  const c = await openChat(page);
  await c.locator("[data-ax='reply']").click();
  await c.locator(".ax-t-input").fill("does a started sub keep its slot?");
  await c.locator(".ax-t-send").click();
  await expect(c.locator(".ax-tbody .ax-thinking")).toBeVisible();
  await c.locator("[data-ax='close-thread']").click();

  // Still waiting: the button blinks, no failure yet.
  const thread = c.locator("[data-ax='reply']");
  await expect(thread).toHaveClass(/ax-busy/);
  await expect(thread).not.toHaveClass(/ax-failed/);
  await capture(c, "answers-thread-btn-busy");

  // The send reaches the invoke only after the stream listener is set up.
  await page.waitForFunction(() => typeof (window as unknown as { __fail?: () => void }).__fail === "function");
  await page.evaluate(() => (window as unknown as { __fail: () => void }).__fail());
  await expect(thread).toHaveClass(/ax-failed/);
  await expect(thread).not.toHaveClass(/ax-busy/);
  await expect(thread).toHaveAttribute("title", "Your follow-up failed. Open the thread to see why");
  const dot = await thread.evaluate((el) => {
    const s = getComputedStyle(el, "::after");
    return { w: s.width, h: s.height, bg: s.backgroundColor, content: s.content };
  });
  expect(dot).toMatchObject({ w: "6px", h: "6px", content: '""' });
  expect(dot.bg).not.toBe("rgba(0, 0, 0, 0)");
  await capture(c, "answers-thread-btn-failed");

  // Opening the thread shows the error; leaving it takes the dot away.
  await thread.click();
  await expect(c.locator(".ax-error")).toBeVisible();
  await capture(c, "answers-thread-failed-error");
  await c.locator("[data-ax='close-thread']").click();
  await expect(c.locator("[data-ax='reply']")).not.toHaveClass(/ax-failed/);
});
