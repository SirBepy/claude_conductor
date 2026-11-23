// asserts: src/views/sessions/chat-dashboard/answers-card.ts, src/views/sessions/chat-dashboard/answers-card.css, src/views/sessions/chat-dashboard/answers-api.ts
import { test, expect, type Locator, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// An Answers-card follow-up never shows a red failed dot (Joe, 2026-11-18): a failed send is
// retried once without a word, a send that fails twice keeps the question and draws a quiet
// line with Try again inside the thread, and a reply that lands while the thread is closed
// puts a primary-colour dot on the thread button until the thread is opened. Dark and light.
// (The phone draws Messages, not this card, so there is no phone-width case.)

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
const REPLY = "Only the queued ones keep waiting.";

type Step = "fail" | "ok";

/** `read` marks the answer read at 1ms (so a later reply makes it unread again); `hold` keeps the first send
 *  open until the spec calls `__release`, like a reply that takes a while. */
async function openChat(page: Page, theme: string, read: boolean) {
  await page.setViewportSize({ width: 1100, height: 820 });
  const store = { read: read ? { a1: 1 } : {}, threads: {}, questions: [] };
  await page.addInitScript(() => { (window as unknown as { __ccPrivateAsk?: boolean }).__ccPrivateAsk = true; }); // the private ask is off by default
  await mountView(page, {
    view: "sessions",
    chatView: "dashboard",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      load_history_page: { events: HISTORY, oldest_seq: 0, newest_seq: HISTORY.length, has_more: false },
      answers_state: store,
      ask_list_threads: [],
      answers_mark: store,
      answers_thread_prewarm: { ok: true },
    },
  });
  await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
  await page.locator(`#sessions-list li[data-session-id="${SESSION.session_id}"]`).click();
  await page.waitForFunction((name) => {
    const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
    return (w.__ccListeners?.get(name)?.size ?? 0) > 0;
  }, CHANNEL);
  const c = page.locator("#session-pane .cdash-answers");
  if (read) {
    // Every answer read: the card says All caught up, so History brings the answer back.
    await c.locator("[data-ax='history']").first().click();
    await page.locator(".cp-row").first().click();
  }
  return c;
}

/** Scripts the daemon's `answers_thread_send`: each call takes the next step. */
async function script(page: Page, plan: Step[], hold = false) {
  await page.evaluate(({ plan, hold, reply }) => {
    const w = window as unknown as {
      __TAURI__: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
      __plan: string[]; __sends: number; __release?: () => void;
    };
    w.__plan = [...plan];
    w.__sends = 0;
    const inner = w.__TAURI__.core.invoke;
    w.__TAURI__.core.invoke = (cmd, args) => {
      if (cmd !== "answers_thread_send") return inner(cmd, args);
      w.__sends += 1;
      const step = w.__plan.shift() ?? "ok";
      return new Promise((res, rej) => {
        const settle = () => (step === "fail"
          ? rej(new Error("answers_thread_send: could not reach your PC (Failed to fetch)"))
          : res({
            thread: { id: "th1", created_at: 1, updated_at: 2, sidecar_session_id: "s1", messages: [
              { role: "user", text: String(args?.question), ts: Date.now() },
              { role: "assistant", text: reply, ts: Date.now() + 1 },
            ] },
            state: { read: (args as { key?: string } | undefined)?.key ? { a1: 1 } : {}, threads: { a1: "th1" }, questions: [] },
          }));
        if (hold && w.__sends === 1) w.__release = settle; else settle();
      });
    };
  }, { plan, hold, reply: REPLY });
}

const sends = (page: Page) => page.evaluate(() => (window as unknown as { __sends: number }).__sends);
const ask = async (c: Locator, text: string) => {
  await c.locator(".ax-t-input").fill(text);
  await c.locator(".ax-t-send").click();
};
/** The computed colour of a throwaway element painted with `css`, so a spec compares against the theme's token. */
const token = (page: Page, prop: "color" | "backgroundColor", value: string) => page.evaluate(({ prop, value }) => {
  const el = document.createElement("i");
  el.style.cssText = `position:fixed;${prop === "color" ? "color" : "background-color"}:${value}`;
  document.body.appendChild(el);
  const out = getComputedStyle(el)[prop];
  el.remove();
  return out;
}, { prop, value });

for (const theme of ["void", "light"]) {
  test.describe(`${theme} theme`, () => {
    test("a send that fails once is retried quietly: no error, no dot, the reply lands", async ({ page }) => {
      const c = await openChat(page, theme, false);
      await script(page, ["fail", "ok"]);
      await c.locator("[data-ax='reply']").click();
      await ask(c, "does a started sub keep its slot?");
      await expect(c.locator(".ax-tbody")).toContainText(REPLY, { timeout: 8000 });
      expect(await sends(page)).toBe(2);
      await expect(c.locator(".ax-error")).toHaveCount(0);
      await expect(c.locator(".ax-failed")).toHaveCount(0);
      await capture(c, `answers-followup-retried-${theme}`);
    });

    test("a send that fails twice keeps the question, shows a quiet line in the thread with Try again, and draws no red dot", async ({ page }) => {
      const c = await openChat(page, theme, false);
      await script(page, ["fail", "fail", "ok"], true);
      await c.locator("[data-ax='reply']").click();
      await ask(c, "does a started sub keep its slot?");
      await expect(c.locator(".ax-tbody .ax-thinking")).toBeVisible();
      await c.locator("[data-ax='close-thread']").click();
      const thread = c.locator("[data-ax='reply']");
      await expect(thread).toHaveClass(/ax-busy/);
      await page.evaluate(() => (window as unknown as { __release: () => void }).__release());
      // The retry fails too: the blink stops and nothing red takes its place.
      await expect(thread).not.toHaveClass(/ax-busy/, { timeout: 8000 });
      expect(await sends(page)).toBe(2);
      await expect(thread).not.toHaveClass(/ax-failed/);
      await expect(c.locator(".ax-failed")).toHaveCount(0);
      const after = await thread.evaluate((el) => getComputedStyle(el, "::after").content);
      expect(after, "no dot at all on the button").toBe("none");

      await thread.click();
      const err = c.locator(".ax-error");
      await expect(err).toBeVisible();
      await expect(c.locator(".ax-tbody .msg.user").last()).toContainText("does a started sub keep its slot?");
      const look = await err.evaluate((el) => {
        const s = getComputedStyle(el);
        return { color: s.color, bg: s.backgroundColor, left: s.borderLeftWidth, top: s.borderTopWidth };
      });
      expect(look.color, "muted text, not the danger colour").not.toBe(await token(page, "color", "var(--color-danger)"));
      expect(look.color).toBe(await token(page, "color", "var(--color-text-muted)"));
      expect(look).toMatchObject({ bg: "rgba(0, 0, 0, 0)", left: "2px", top: "0px" });
      await capture(c, `answers-followup-final-error-${theme}`);

      // Try again sends the kept question; the error leaves and the reply lands.
      await c.locator("[data-ax='retry-send']").click();
      await expect(c.locator(".ax-tbody")).toContainText(REPLY, { timeout: 8000 });
      await expect(c.locator(".ax-error")).toHaveCount(0);
    });

    test("a reply that lands while the thread is closed puts a primary dot on the thread button, and opening the thread clears it", async ({ page }) => {
      const c = await openChat(page, theme, true);
      await script(page, ["ok"], true);
      const thread = c.locator("[data-ax='reply']");
      await expect(thread).not.toHaveClass(/ax-unread-reply/);
      await thread.click();
      await ask(c, "does a started sub keep its slot?");
      await c.locator("[data-ax='close-thread']").click();
      await expect(thread).toHaveClass(/ax-busy/);
      await page.evaluate(() => (window as unknown as { __release: () => void }).__release());

      await expect(thread).toHaveClass(/ax-unread-reply/);
      await expect(thread).not.toHaveClass(/ax-busy/);
      await expect(thread).toHaveAttribute("title", /New reply/);
      const dot = await thread.evaluate((el) => {
        const s = getComputedStyle(el, "::after");
        return { w: s.width, h: s.height, bg: s.backgroundColor, content: s.content };
      });
      expect(dot).toMatchObject({ w: "6px", h: "6px", content: '""' });
      expect(dot.bg, "the app's primary colour").toBe(await token(page, "backgroundColor", "var(--color-primary)"));
      await capture(c, `answers-thread-btn-unread-${theme}`);

      await thread.click();
      await c.locator("[data-ax='close-thread']").click();
      await expect(c.locator("[data-ax='reply']")).not.toHaveClass(/ax-unread-reply/);
      await expect(c.locator("[data-ax='reply']")).toHaveAttribute("title", /back-and-forth/);
    });
  });
}
