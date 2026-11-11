// asserts: src/views/sessions/chat-dashboard/answers-card.ts, src/views/sessions/chat-dashboard/answers-api.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, fireEvent, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// An Answers-card thread on a warm process (Joe, 2026-11-11): opening the thread
// starts its process (answers_thread_prewarm), and the reply streams into the
// thread as `answers-thread-delta` events before the send itself returns.

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
const REPLY = "Only the queued ones. A sub that **already started** keeps its slot until it finishes, so a main chat can sit at 12 for a while.";

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
  // The send stays open until the spec releases it, like a reply still streaming.
  await page.evaluate((reply) => {
    const w = window as unknown as {
      __TAURI__: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
      __release?: () => void;
    };
    const inner = w.__TAURI__.core.invoke;
    w.__TAURI__.core.invoke = (cmd, args) => {
      if (cmd !== "answers_thread_send") return inner(cmd, args);
      (window as unknown as { __ccInvokeCalls: unknown[] }).__ccInvokeCalls.push({ cmd, args });
      return new Promise((res) => {
        w.__release = () => res({
          thread: { id: "th1", created_at: 1, updated_at: 2, sidecar_session_id: "s1", messages: [
            { role: "user", text: String(args?.question), ts: 1 },
            { role: "assistant", text: reply, ts: 2 },
          ] },
          state: { read: {}, threads: { a1: "th1" }, questions: [] },
        });
      });
    };
  }, REPLY);
  return page.locator("#session-pane .cdash-answers");
}

const calls = (page: Page, cmd: string) =>
  page.evaluate((cmd) => (window as unknown as { __ccInvokeCalls: { cmd: string; args?: Record<string, unknown> }[] }).__ccInvokeCalls.filter((c) => c.cmd === cmd), cmd);

test("opening a thread warms its process, and the reply streams in before the send returns", async ({ page }) => {
  const c = await openChat(page);
  await c.locator("[data-ax='reply']").click();
  await expect.poll(async () => (await calls(page, "answers_thread_prewarm")).length).toBe(1);
  expect((await calls(page, "answers_thread_prewarm"))[0]!.args).toMatchObject({ sessionId: SESSION.session_id, key: "a1" });

  await c.locator(".ax-t-input").fill("does a started sub keep its slot?");
  await c.locator(".ax-t-send").click();
  await expect(c.locator(".ax-tbody .ax-thinking")).toBeVisible();
  const streamId = (await calls(page, "answers_thread_send"))[0]!.args!.streamId as string;
  expect(streamId).toBeTruthy();

  // Someone else's stream never lands here.
  await fireEvent(page, "answers-thread-delta", [{ session_id: SESSION.session_id, stream_id: "other", text: "not mine" }]);
  await fireEvent(page, "answers-thread-delta", [{ session_id: SESSION.session_id, stream_id: streamId, text: "Only the queued ones. A sub that" }]);
  const live = c.locator(".ax-tbody .ax-live");
  await expect(live).toContainText("Only the queued ones. A sub that");
  await expect(c.locator(".ax-tbody")).not.toContainText("not mine");
  await expect(c.locator(".ax-tbody .ax-thinking")).toHaveCount(0);
  await capture(c, "answers-thread-streaming");

  await fireEvent(page, "answers-thread-delta", [{ session_id: SESSION.session_id, stream_id: streamId, text: REPLY }]);
  await expect(live).toContainText("sit at 12 for a while");

  await page.evaluate(() => (window as unknown as { __release: () => void }).__release());
  await expect(live).toHaveCount(0);
  await expect(c.locator(".ax-tbody .ax-t-bub").last()).toContainText("sit at 12 for a while");
});
