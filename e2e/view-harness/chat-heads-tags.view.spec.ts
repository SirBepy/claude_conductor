// asserts: src/views/sessions/chat-heads.ts, src/views/sessions/chat-heads.css, src/views/sessions/chat-heads-model.ts, src/views/sessions/sidebar.ts, src/shared/chat/dashboard/answers-model.ts
import { test, expect, type Locator, type Page } from "@playwright/test";
import { capture, fireEvent, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// The top-right tag of a chat head: how many answers Joe has not read (the Answers card's number,
// "9+" over nine, nothing at zero) and, inline beside it, a pencil when the chat holds a draft to
// send. Hidden chats roll their count up onto the eye. The tag floats over the corner, so no head
// and neither bottom corner (project badge, model battery) moves when it comes and goes.

const DESKTOP = { width: 1280, height: 800 };
const MIN = 60_000;
const since = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const SEND = "mcp__cc_conductor__send_message";
const AT = 1_762_783_260;
const CHAR_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAoMBgDTD2qgAAAAASUVORK5CYII=";

type Over = Parameters<typeof sessionInstance>[0];
const chat = (id: string, name: string, pid: number, over: Over = {}) =>
  sessionInstance({ session_id: id, name, pid, cwd: "C:/Projects/claude_usage_in_taskbar", started_at: since((30 - pid % 100) * MIN), awaiting: "done", ...over });

const SESSIONS = [chat("a", "Alpha", 101), chat("b", "Bravo", 102), chat("h", "Hidden one", 103)];

let n = 0;
const tool = (tool_name: string, input: Record<string, unknown>, id = `t${++n}`, timestamp = 0) => [
  { type: "tool_use", tool_name, input, id, timestamp, parent_tool_use_id: null },
  { type: "tool_result", tool_use_id: id, output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 },
];
const user = (text: string) => ({ type: "user_message", content: [{ type: "text", text }], timestamp: 0 });
const answer = (i: number) => [
  user(`question ${i}`),
  ...tool(SEND, { kind: "answer", verdict: `Answer ${i}`, question: `Question ${i}?`, text: "Done." }, `ans${i}`, AT + i * 100),
];
const history = (count: number) => Array.from({ length: count }, (_, i) => answer(i + 1)).flat();

const EMPTY_STORE = { read: {}, threads: {}, questions: [], rewrites: {} };
const draft = (origin: string) => ({
  id: "d1", topic: "Reply to Bruno", brief: "", receipts: [], state: "needs-you", origin_session_id: origin, origin_label: "x",
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), seen_by_origin: true,
  variants: [{ recipient: "Bruno", handle_n: 1, versions: [{ n: 1, body: "hi", author: "claude", note: "", created_at: "" }], current: 1, person: null, platform: "Slack", sent: false }],
});

async function mount(page: Page, opts: { answers?: number; drafts?: unknown[]; hidden?: string[]; asking?: string } = {}): Promise<void> {
  const events = history(opts.answers ?? 3);
  const sessions = SESSIONS.map((s) => s.session_id === opts.asking ? { ...s, awaiting: "question" as const } : s);
  await page.setViewportSize(DESKTOP);
  await page.addInitScript((ids) => { localStorage.setItem("cc_hidden_sessions", JSON.stringify(ids)); }, opts.hidden ?? ["h"]);
  await mountView(page, {
    view: "sessions",
    chatView: "dashboard",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: sessions, get_active_sessions: sessions,
      list_session_characters: { a: "a", b: "b", h: "c" },
      character_asset_url: CHAR_URL,
      get_project_icon: null,
      get_project_tech: null,
      load_history_page: { events, oldest_seq: 0, newest_seq: events.length, has_more: false },
      answers_state: EMPTY_STORE,
      ask_list_threads: [],
      answers_mark: EMPTY_STORE,
      list_message_drafts: { drafts: opts.drafts ?? [], people: [] },
    },
  });
  await page.locator("#sessions-list li.chat-head[data-session-id]").first().waitFor();
}

const head = (page: Page, id: string): Locator => page.locator(`#sessions-list li[data-session-id="${id}"]`);
const tagOf = (page: Page, id: string): Locator => head(page, id).locator(".chat-head-tag");
const eye = (page: Page): Locator => page.locator("#sessions-list li[data-heads-hidden]");

async function openHead(page: Page, id: string): Promise<void> {
  await head(page, id).click();
  await page.waitForFunction((name) => {
    const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
    return (w.__ccListeners?.get(name)?.size ?? 0) > 0;
  }, `chat:${id}`);
}

/** Every head's box plus its two bottom corners (project badge, model battery). */
const boxes = (page: Page) => page.evaluate(() => {
  const r = (el: Element | null) => { const b = el?.getBoundingClientRect(); return b ? [Math.round(b.x * 10), Math.round(b.y * 10), Math.round(b.width * 10), Math.round(b.height * 10)] : null; };
  return [...document.querySelectorAll("#sessions-list > li")].map((li) => ({
    id: (li as HTMLElement).dataset.rowKey,
    li: r(li), face: r(li.querySelector(".chat-head-face")), badge: r(li.querySelector(".chat-head-badge")), battery: r(li.querySelector(".chat-head-battery")),
  }));
});

test.describe("view-harness / chat heads tag", () => {
  test("an opened chat's head wears its unread count, and so does it after another chat opens", async ({ page }) => {
    await mount(page);
    await expect(tagOf(page, "a")).toHaveCount(0);
    await openHead(page, "a");
    await expect(tagOf(page, "a").locator(".ht-n")).toHaveText("3");
    await openHead(page, "b");
    await expect(tagOf(page, "b").locator(".ht-n")).toHaveText("3");
    // a is parked now: its number comes from its cached transcript.
    await expect(tagOf(page, "a").locator(".ht-n")).toHaveText("3");
    await expect(tagOf(page, "a").locator(".ht-draft")).toHaveCount(0);
    await capture(page, "chat-heads-tag-count");
  });

  test("the count reads 9+ over nine and drops as answers are read", async ({ page }) => {
    await mount(page, { answers: 11 });
    await openHead(page, "a");
    await expect(tagOf(page, "a").locator(".ht-n")).toHaveText("9+");
    await expect(tagOf(page, "a").locator(".ht-n")).toHaveAttribute("aria-label", "11 unread answers");
  });

  test("Got it lowers the count and the last one takes the tag away", async ({ page }) => {
    await mount(page, { answers: 2 });
    await openHead(page, "a");
    const gotit = page.locator("#session-pane .cdash-answers [data-ax='gotit']");
    await expect(tagOf(page, "a").locator(".ht-n")).toHaveText("2");
    await gotit.click();
    await expect(tagOf(page, "a").locator(".ht-n")).toHaveText("1");
    // The card walks to the older answer before its check can be pressed again.
    await expect(page.locator("#session-pane .cdash-answers .ax-face .mc-verdict")).toHaveText("Answer 1");
    await page.waitForTimeout(500);
    await page.locator("#session-pane .cdash-answers [data-ax='gotit']").click();
    await expect(tagOf(page, "a")).toHaveCount(0);
  });

  test("a chat that holds a draft shows a pencil inline beside the count, in one tag", async ({ page }) => {
    await mount(page, { drafts: [draft("a")] });
    await openHead(page, "a");
    const tag = tagOf(page, "a");
    await expect(tag.locator(".ht-n")).toHaveText("3");
    await expect(tag.locator(".ht-draft .ph-pencil-simple")).toHaveCount(1);
    const n = (await tag.locator(".ht-n").boundingBox())!;
    const d = (await tag.locator(".ht-draft").boundingBox())!;
    expect(d.x, "the pencil sits right of the count").toBeGreaterThan(n.x + n.width - 1);
    expect(Math.abs(d.y + d.height / 2 - (n.y + n.height / 2)), "inline: the same row").toBeLessThan(2);
    // The tag is the head's top-right corner: it overlaps the head's right edge and top edge.
    const h = (await head(page, "a").boundingBox())!;
    const t = (await tag.boundingBox())!;
    expect(t.y).toBeLessThan(h.y + 4);
    expect(t.x + t.width).toBeGreaterThan(h.x + h.width - 4);
    await capture(page, "chat-heads-tag-count-and-draft");
  });

  test("a draft alone shows only the pencil, and a chat without either shows no tag", async ({ page }) => {
    await mount(page, { answers: 0, drafts: [draft("b")] });
    await expect(tagOf(page, "b").locator(".ht-draft")).toHaveCount(1);
    await expect(tagOf(page, "b").locator(".ht-n")).toHaveCount(0);
    await expect(tagOf(page, "a")).toHaveCount(0);
  });

  test("no head and neither bottom corner moves when the tag grows, shrinks or goes", async ({ page }) => {
    await mount(page, { answers: 1, drafts: [draft("a")] });
    // Opening a chat steps its head out, so the chat is open before anything is measured.
    await openHead(page, "a");
    await expect(tagOf(page, "a").locator(".ht-n")).toHaveText("1");
    await page.waitForTimeout(900);
    const withBoth = await boxes(page);
    const key = (rows: Awaited<ReturnType<typeof boxes>>) => rows.map((b) => [b.id, b.li, b.face, b.badge, b.battery]);
    await page.locator("#session-pane .cdash-answers [data-ax='gotit']").click();
    await expect(tagOf(page, "a").locator(".ht-n")).toHaveCount(0);
    await expect(tagOf(page, "a").locator(".ht-draft")).toHaveCount(1);
    await page.waitForTimeout(900);
    expect(key(await boxes(page)), "the count leaving moves nothing").toEqual(key(withBoth));
    await fireEvent(page, "chat:a", [user("one more"), ...tool(SEND, { kind: "answer", verdict: "More", question: "More?", text: "Yes." }, "late0", AT + 8000)]);
    await expect(tagOf(page, "a").locator(".ht-n")).toHaveText("1");
    await page.waitForTimeout(900);
    expect(key(await boxes(page)), "the count arriving moves nothing").toEqual(key(withBoth));
  });

  test("a chat that asks shows its red count alone: the unread number steps aside, the draft pencil stays", async ({ page }) => {
    await mount(page, { asking: "b", drafts: [draft("b")] });
    await openHead(page, "b");
    await expect(head(page, "b").locator(".chat-head-count")).toHaveText("1");
    await expect(tagOf(page, "b").locator(".ht-n")).toHaveCount(0);
    const red = (await head(page, "b").locator(".chat-head-count").boundingBox())!;
    const pencil = (await tagOf(page, "b").locator(".ht-draft").boundingBox())!;
    expect(red.x + red.width, "the red count ends before the pencil begins").toBeLessThan(pencil.x);
    const h = (await head(page, "b").boundingBox())!;
    expect(red.x).toBeLessThan(h.x + h.width / 2);
  });

  test("a hidden chat's unread answers draw no number on the eye or on its own head", async ({ page }) => {
    await mount(page);
    await expect(eye(page)).toHaveCount(1);
    await eye(page).click();
    await openHead(page, "h");
    // The hidden chat is open and has 3 unread answers: its head wears neither a count nor a tag.
    await expect(head(page, "h")).toHaveCount(1);
    await expect(head(page, "h").locator(".chat-head-count, .ht-n")).toHaveCount(0);
    await page.locator("#sessions-list li[data-heads-back]").click();
    // The eye's one number is how many chats are hidden.
    await expect(eye(page).locator(".chat-head-count")).toHaveText("1");
    await expect(eye(page).locator(".chat-head-tag")).toHaveCount(0);
    await expect(head(page, "h")).toHaveCount(0);
    await capture(page, "chat-heads-tag-eye-one-number");
  });

  test("the count pops in once when it rises and a status update replays nothing", async ({ page }) => {
    await mount(page, { answers: 1 });
    await openHead(page, "a");
    await expect(tagOf(page, "a").locator(".ht-n")).toHaveText("1");
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const w = window as unknown as { __runs: string[] };
      w.__runs = [];
      document.querySelector("#sessions-list")!.addEventListener("animationstart", (e) => {
        const t = e.target as HTMLElement;
        if (t.closest('li[data-session-id="a"]') && t.closest(".chat-head-tag")) w.__runs.push(`${t.className}:${(e as AnimationEvent).animationName}`);
      });
    });
    await fireEvent(page, "chat:a", [user("another one"), ...tool(SEND, { kind: "answer", verdict: "Another", question: "Another?", text: "Yes." }, "late1", AT + 9000)]);
    await expect(tagOf(page, "a").locator(".ht-n")).toHaveText("2");
    await page.waitForTimeout(500);
    const runs = await page.evaluate(() => (window as unknown as { __runs: string[] }).__runs);
    expect(runs.length, "one pop for the rise").toBe(1);
    expect(runs[0]).toContain("ht-pop");
    // A status tick re-renders every head: the tag keeps its node and nothing restarts.
    const marker = await tagOf(page, "a").evaluate((el) => { (el as unknown as Record<string, boolean>).__kept = true; return true; });
    expect(marker).toBe(true);
    await fireEvent(page, "instances-changed", [null]);
    await page.waitForTimeout(700);
    expect(await tagOf(page, "a").evaluate((el) => !!(el as unknown as Record<string, boolean>).__kept)).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { __runs: string[] }).__runs.length)).toBe(1);
  });

  test("reduced motion fades the tag in instead of popping it", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mount(page, { answers: 1 });
    await openHead(page, "a");
    await expect(tagOf(page, "a").locator(".ht-n")).toHaveText("1");
    await page.evaluate(() => {
      const w = window as unknown as { __names: string[] };
      w.__names = [];
      document.querySelector("#sessions-list")!.addEventListener("animationstart", (e) => {
        if ((e.target as HTMLElement).closest(".chat-head-tag")) w.__names.push((e as AnimationEvent).animationName);
      });
    });
    await fireEvent(page, "chat:a", [user("again"), ...tool(SEND, { kind: "answer", verdict: "Again", question: "Again?", text: "Yes." }, "late2", AT + 9100)]);
    await expect(tagOf(page, "a").locator(".ht-n")).toHaveText("2");
    await page.waitForTimeout(400);
    const names = await page.evaluate(() => (window as unknown as { __names: string[] }).__names);
    expect(names).toEqual(["ht-fade"]);
  });
});
