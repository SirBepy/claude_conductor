// Reviewed 2026-11-12 (shown badly): chat-dashboard.ts adds a contextmenu listener for the card menu's "Shown badly" item (chat-shown-badly.view.spec.ts covers it); nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-12 (per-chat previews): the Preview card lists only the previews this chat pushed (newest big, the rest as a thumbnail strip) and folds the family's others behind "N more by other chats"; nothing this spec asserts changed, and it passes.
// asserts: src/views/sessions/chat-dashboard/answers-card.ts, src/views/sessions/chat-dashboard/answers-card.css, src/views/sessions/chat-dashboard/chat-dashboard.ts, src/shared/chat/dashboard/answers-model.ts, src/views/sessions/drafts-revise.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// Send thread to chat (Joe, 2026-11-11): a thread Joe talked through on the
// Answers card hands over to the chat that wrote the answer in one click, as
// his own message: the thread verbatim under a quote of the answer, with what
// he typed in the thread's box as the ask.

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
  { type: "user_message", content: [{ type: "text", text: "and the token?" }], timestamp: 0 },
  ...tool(SEND, { kind: "answer", verdict: "Read-only is enough", question: "Does the token need write access?", text: "It only reads boards." }, "a2"),
  ...tool("mcp__cc_conductor__report_turn_status", { status: "done" }, "t2"),
];
const STORE = { read: {}, threads: { a1: "th1" }, questions: [] };
const THREAD = {
  id: "th1", created_at: 1, updated_at: 2, sidecar_session_id: "s1",
  messages: [
    { role: "user", text: "so a main chat can sit at 12?", ts: 1 },
    { role: "assistant", text: "Yes, until the started ones finish.", ts: 2 },
  ],
};

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
      ask_list_threads: [THREAD],
      answers_mark: STORE,
      answers_thread_prewarm: { ok: true },
      send_message: null,
    },
  });
  await page.locator(`#sessions-list li[data-session-id="${SESSION.session_id}"]`).click();
  await page.waitForFunction((name) => {
    const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
    return (w.__ccListeners?.get(name)?.size ?? 0) > 0;
  }, CHANNEL);
  return page.locator("#session-pane .cdash-answers");
}

const sends = (page: Page) =>
  page.evaluate(() => (window as unknown as { __ccInvokeCalls: { cmd: string; args?: Record<string, unknown> }[] }).__ccInvokeCalls.filter((c) => c.cmd === "send_message"));

test("a thread with a follow-up hands itself to the chat as Joe's message, with the box's text as the ask", async ({ page }) => {
  const c = await openChat(page);
  // The newest answer (no thread) is on the card; History opens the threaded one.
  await expect(c.locator(".ax-face .mc-verdict")).toHaveText("Read-only is enough");
  await c.locator("[data-ax='history']").click();
  await page.locator(".cp-row",{ hasText: "Yes, it is soft" }).click();
  await expect(c.locator(".ax-face .mc-verdict")).toHaveText("Yes, it is soft");
  await c.locator("[data-ax='reply']").click();

  const btn = c.locator(".ax-tbody [data-ax='handoff']");
  await expect(btn).toHaveText("Send thread to chat");
  await expect(btn).toBeEnabled();
  await c.locator(".ax-t-input").fill("then raise the cap to 12");
  await capture(c, "answers-thread-handoff");
  await btn.click();

  await expect.poll(async () => (await sends(page)).length).toBe(1);
  const [call] = await sends(page);
  expect(call!.args!.sessionId).toBe(SESSION.session_id);
  const text = (call!.args!.blocks as { type: string; text: string }[])[0]!.text;
  expect(text.startsWith("> Re: Yes, it is soft\n\nthen raise the cap to 12\n")).toBe(true);
  expect(text).toContain("**Me:** is the cap soft?");
  expect(text).toContain("**Your answer:** Yes, it is soft\n\nA queued sub that starts later does not re-check it.");
  expect(text).toContain("**Me:** so a main chat can sit at 12?");
  expect(text).toContain("**Thread:** Yes, until the started ones finish.");

  // Sent: the ask left the box with the thread, and a second click cannot send it twice.
  await expect(btn).toHaveText("Sent to chat");
  await expect(btn).toBeDisabled();
  await expect(c.locator(".ax-t-input")).toHaveValue("");
});

test("a failed send keeps the button and the typed ask, so nothing reads as sent", async ({ page }) => {
  const c = await openChat(page);
  await page.evaluate(() => {
    const w = window as unknown as { __TAURI__: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } } };
    const inner = w.__TAURI__.core.invoke;
    w.__TAURI__.core.invoke = (cmd, args) => (cmd === "send_message" ? Promise.reject(new Error("daemon unreachable")) : inner(cmd, args));
  });
  await c.locator("[data-ax='history']").click();
  await page.locator(".cp-row", { hasText: "Yes, it is soft" }).click();
  await c.locator("[data-ax='reply']").click();
  const btn = c.locator(".ax-tbody [data-ax='handoff']");
  await c.locator(".ax-t-input").fill("then raise the cap to 12");
  await btn.click();
  await expect(page.locator(".toast", { hasText: "daemon unreachable" }).first()).toBeVisible();
  await expect(btn).toHaveText("Send thread to chat");
  await expect(btn).toBeEnabled();
  await expect(c.locator(".ax-t-input")).toHaveValue("then raise the cap to 12");
});

test("a thread with nothing the chat has not seen offers no hand-off", async ({ page }) => {
  const c = await openChat(page);
  await expect(c.locator(".ax-face .mc-verdict")).toHaveText("Read-only is enough");
  await c.locator("[data-ax='reply']").click();
  await expect(c.locator(".ax-tbody .ax-t-bub")).toHaveCount(1);
  await expect(c.locator("[data-ax='handoff']")).toHaveCount(0);
});
