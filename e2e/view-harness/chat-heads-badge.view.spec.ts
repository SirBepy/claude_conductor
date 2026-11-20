// asserts: src/views/sessions/chat-heads.ts, src/views/sessions/chat-heads.css, src/views/sessions/chat-heads-model.ts, src/views/sessions/sidebar.ts, src/views/sessions/chat-seen.ts, src/views/sessions/main-chat.ts
import { test, expect, type Locator, type Page } from "@playwright/test";
import { capture, fireEvent, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// The priority badge on a chat head (V2): ONE number at the top-right, red when the chat asks, else
// purple for unread answers, else green for finished subs Joe has not seen. No status ring on a circle.
// A hidden chat and the eye button never carry a number. Dark and light.

const DESKTOP = { width: 1280, height: 800 };
const MIN = 60_000;
const since = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const SEND = "mcp__cc_conductor__send_message";
const AT = Math.floor(Date.now() / 1000) + 3600;
const CHAR_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAoMBgDTD2qgAAAAASUVORK5CYII=";
const CWD = "C:/Projects/claude_usage_in_taskbar";

type Over = Parameters<typeof sessionInstance>[0];
const chat = (id: string, name: string, pid: number, over: Over = {}) =>
  sessionInstance({ session_id: id, name, pid, cwd: CWD, started_at: since((30 - pid % 100) * MIN), awaiting: "done", ...over });
const sub = (id: string, name: string, pid: number) =>
  chat(id, name, pid, { subchat_of: "m", busy: false, awaiting: "done", subchat_finished: true, progress: { plan: null, state_since: since(10 * MIN) } as never });

const SESSIONS = [
  chat("a", "Unread answers", 101),
  chat("r", "Asks and has unread", 102, { awaiting: "question" }),
  chat("m", "Main with finished subs", 103),
  sub("s1", "Copy", 104),
  sub("s2", "Fonts", 105),
  chat("i", "Idle", 106),
  chat("h", "Hidden", 107),
];

let n = 0;
const tool = (tool_name: string, input: Record<string, unknown>, id = `t${++n}`, timestamp = 0) => [
  { type: "tool_use", tool_name, input, id, timestamp, parent_tool_use_id: null },
  { type: "tool_result", tool_use_id: id, output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 },
];
const answer = (i: number) => [
  { type: "user_message", content: [{ type: "text", text: `question ${i}` }], timestamp: 0 },
  ...tool(SEND, { kind: "answer", verdict: `Answer ${i}`, question: `Question ${i}?`, text: "Done." }, `ans${i}`, AT + i * 100),
];
const EVENTS = [1, 2, 3].flatMap(answer);
const EMPTY_STORE = { read: {}, threads: {}, questions: [], rewrites: {} };

async function mount(page: Page, theme: string): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await page.addInitScript(() => { localStorage.setItem("cc_hidden_sessions", JSON.stringify(["h"])); });
  await mountView(page, {
    view: "sessions",
    chatView: "dashboard",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      get_settings: { theme },
      list_instances: SESSIONS, get_active_sessions: SESSIONS,
      list_subchats_on: ["m"],
      list_session_characters: { a: "a", r: "b", m: "c", i: "a", h: "b" },
      character_asset_url: CHAR_URL,
      get_project_icon: null, get_project_tech: null,
      load_history_page: { events: EVENTS, oldest_seq: 0, newest_seq: EVENTS.length, has_more: false },
      answers_state: EMPTY_STORE, ask_list_threads: [], answers_mark: EMPTY_STORE,
      list_message_drafts: { drafts: [], people: [] },
    },
  });
  await page.locator("#sessions-list li.chat-head[data-session-id]").first().waitFor();
}

const head = (page: Page, id: string): Locator => page.locator(`#sessions-list li[data-session-id="${id}"]`);
const num = (page: Page, id: string): Locator => head(page, id).locator(".chat-head-tag .ht-n");

async function openHead(page: Page, id: string): Promise<void> {
  await head(page, id).click();
  await page.waitForFunction((name) => {
    const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
    return (w.__ccListeners?.get(name)?.size ?? 0) > 0;
  }, `chat:${id}`);
}

/** Leaves "a" and "r" behind with their three unread answers, "i" open. */
async function arrange(page: Page): Promise<void> {
  await openHead(page, "a");
  await openHead(page, "r");
  await openHead(page, "i");
}

const bg = (l: Locator) => l.evaluate((el) => getComputedStyle(el).backgroundColor);
/** WCAG contrast between the number's text and its own fill. */
const contrast = (l: Locator) => l.evaluate((el) => {
  const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  const lum = ([r, g, b]: number[]) => {
    const f = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
  };
  const cs = getComputedStyle(el);
  const a = lum(rgb(cs.color)), b = lum(rgb(cs.backgroundColor));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
});

for (const [theme, mode] of [["void", "dark"], ["void-light", "light"]] as const) {
  test.describe(`view-harness / chat head priority badge (${mode})`, () => {
    test.beforeEach(async ({ page }) => {
      await mount(page, theme);
      await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
      await arrange(page);
    });

    test("red outranks purple, purple outranks green, and every head wears one number at most", async ({ page }) => {
      await expect(num(page, "r")).toHaveText("1");
      await expect(num(page, "r")).toHaveClass(/is-red/);
      await expect(num(page, "a")).toHaveText("3");
      await expect(num(page, "a")).toHaveClass(/is-purple/);
      await expect(num(page, "m")).toHaveText("2");
      await expect(num(page, "m")).toHaveClass(/is-green/);
      await expect(num(page, "i")).toHaveCount(0);
      for (const id of ["a", "r", "m", "i"]) await expect(head(page, id).locator(".ht-n")).toHaveCount(id === "i" ? 0 : 1);
      await expect(page.locator("#sessions-list .chat-head-count")).toHaveCount(1); // the eye's hidden-chats count only
      const fills = new Set([await bg(num(page, "r")), await bg(num(page, "a")), await bg(num(page, "m"))]);
      expect(fills.size, "three kinds, three colours").toBe(3);
      await capture(page.locator("#sessions-list"), `chat-heads-badge-priority-${mode}`);
    });

    test("no head draws a status ring, whatever the chat is doing", async ({ page }) => {
      await expect(page.locator("#sessions-list .avatar-ring")).toHaveCount(0);
      await expect(page.locator("#sessions-list .avatar-status-dot")).toHaveCount(0);
    });

    test("each number stays readable on its own fill", async ({ page }) => {
      for (const id of ["r", "a", "m"]) expect(await contrast(num(page, id)), `${id} contrast`).toBeGreaterThanOrEqual(3);
    });

    test("a hidden chat and the eye button carry no number", async ({ page }) => {
      const eye = page.locator("#sessions-list li[data-heads-hidden]");
      await expect(eye.locator(".chat-head-tag, .ht-n")).toHaveCount(0);
      await eye.click();
      await expect(head(page, "h")).toHaveCount(1);
      await expect(head(page, "h").locator(".chat-head-tag, .ht-n")).toHaveCount(0);
    });

    test("a badge hovered or re-rendered does not move any head", async ({ page }) => {
      const box = () => page.evaluate(() => [...document.querySelectorAll("#sessions-list > li")].map((li) => {
        const b = li.getBoundingClientRect();
        return [Math.round(b.x * 10), Math.round(b.y * 10), Math.round(b.width * 10), Math.round(b.height * 10)];
      }));
      await page.waitForTimeout(600); // the entrance pop and the heads' own settling finish first
      const before = await box();
      const tagBox = (await num(page, "a").boundingBox())!;
      // Hovering a head slides its face a few px (existing); the badge itself keeps its size.
      await head(page, "a").hover();
      await page.waitForTimeout(400);
      const hovered = (await num(page, "a").boundingBox())!;
      expect([hovered.width, hovered.height]).toEqual([tagBox.width, tagBox.height]);
      await page.mouse.move(2, 2);
      await page.waitForTimeout(400);
      await fireEvent(page, "instances-changed", [null]);
      await page.waitForTimeout(400);
      expect(await box()).toEqual(before);
    });

    test("a chat that stops asking changes colour on the same node, with no new element", async ({ page }) => {
      await expect(num(page, "r")).toHaveClass(/is-red/);
      await num(page, "r").evaluate((el) => { (el as unknown as Record<string, boolean>).__kept = true; });
      await page.evaluate((over) => {
        const w = window as unknown as { __TAURI__: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } } };
        const orig = w.__TAURI__.core.invoke;
        w.__TAURI__.core.invoke = async (cmd, args) => {
          const out = await orig(cmd, args);
          return (cmd === "list_instances" || cmd === "get_active_sessions") && Array.isArray(out)
            ? out.map((s: { session_id: string }) => s.session_id === over ? { ...s, awaiting: "done" } : s)
            : out;
        };
      }, "r");
      await fireEvent(page, "question-answered", [{ session_id: "r" }]);
      await fireEvent(page, "instances-changed", [null]);
      await expect(num(page, "r")).toHaveClass(/is-purple/, { timeout: 8_000 });
      await expect(num(page, "r")).toHaveText("3");
      expect(await num(page, "r").evaluate((el) => !!(el as unknown as Record<string, boolean>).__kept)).toBe(true);
    });

    test("a view elsewhere clears a green number on its own, with no other badge changing", async ({ page }) => {
      await expect(num(page, "m")).toHaveText("2");
      await page.evaluate((m) => {
        const w = window as unknown as { __TAURI__: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } } };
        const orig = w.__TAURI__.core.invoke;
        w.__TAURI__.core.invoke = (cmd, args) => cmd === "chat_seen_list" ? Promise.resolve(m) : orig(cmd, args);
      }, { m: Date.now() + 10_000 });
      await expect(num(page, "m")).toHaveCount(0, { timeout: 10_000 });
      await expect(num(page, "a")).toHaveText("3");
      await expect(num(page, "r")).toHaveClass(/is-red/);
    });

    test("another device viewing a chat clears its purple number here", async ({ page }) => {
      await expect(num(page, "a")).toHaveText("3");
      await page.evaluate((m) => {
        const w = window as unknown as { __TAURI__: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } } };
        const orig = w.__TAURI__.core.invoke;
        w.__TAURI__.core.invoke = (cmd, args) => cmd === "chat_seen_list" ? Promise.resolve(m) : orig(cmd, args);
      }, { a: (AT + 10_000) * 1000, m: (Date.now() + 10_000) });
      await expect(num(page, "a")).toHaveCount(0, { timeout: 10_000 });
      await expect(num(page, "m")).toHaveCount(0, { timeout: 10_000 });
      // The question is not a thing a view answers: red stays.
      await expect(num(page, "r")).toHaveClass(/is-red/);
      await capture(page.locator("#sessions-list"), `chat-heads-badge-cleared-${mode}`);
    });
  });
}
