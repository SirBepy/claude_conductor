// Reviewed 2026-11-13 (From subs): the dashboard gained a From subs zone in the left column that draws sub reports which are not answers; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-13 (stale blockers): Waiting on you drops an own blocker once the chat sends a later report, answer, plan or same-target blocker, each Waiting card gains a written time and a hover x (Clear all once two can go) kept per chat in localStorage, and the card copy button is hidden there; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-12 (plan body): the Plan card draws a plan message's lines after its headline under it, muted; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-12 (honest sub states): subs gained queued/paused/usage-limit/stopped kinds with a dim ring and glyph, an avatar hover card, the Plan foot's sub counts and a glowing main-chat ring; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-12 (per-chat previews): the Preview card lists only the previews this chat pushed (newest big, the rest as a thumbnail strip) and folds the family's others behind "N more by other chats"; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-11 (Send thread to chat): an Answers-card thread with a follow-up gains a hand-off button under its latest reply, the dashboard wires its send through sendRevision, and AnswerAuthor carries the sub's id; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-11 (plan-close): chat-dashboard.css gained the `.cdash-step--left` rule only; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-11 (answers pending row): answers-model.ts adds a row per question handed to a sub (spawn_chat, read-only, report_back) until its answer fills it, and the dashboard passes the sub list only once it holds this chat; this spec has no hand-off, nothing it asserts changed, and it passes.
// Reviewed 2026-11-11 (dashboard Drafts card): a new left-column zone draws write_draft drafts, the draft card takes an optional version and Edit form, and the dashboard reads the drafts store; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-10 (answers-question-rewrite): the card asks the daemon for a short question only for an answer with no `question` and a message past 90 chars; this spec's answers carry their own, so it passes.
// Reviewed 2026-11-11 (warm Ask threads): answers-card.ts streams a reply and calls answers_thread_prewarm on open (an unmocked call only logs a warning); this spec passes unchanged.
// asserts: src/views/sessions/chat-dashboard/answers-card.ts, src/views/sessions/chat-dashboard/answers-card.css, src/views/sessions/chat-dashboard/chat-dashboard.css, src/views/sessions/chat-dashboard/dashboard-zones.ts
import { test, expect, type Page, type Locator } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// A long one-line code block and a file path in inline code on the chat
// dashboard (Joe's 2026-11-10 report, on an Answers thread): nothing scrolls
// sideways, the code block scrolls inside its own box, and the file chip sits
// inline without covering the words around it. Covers every dashboard surface
// that draws a message bubble: the answer face, a thread reply, a Notes card.

const SESSION = sessionInstance();
const CHANNEL = `chat:${SESSION.session_id}`;
const SEND = "mcp__cc_conductor__send_message";
const AT = 1_762_783_260;

const LONG_CMD =
  "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-Command','msiexec /x {6F1F6B4C-0000-4C8E-9A11-0123456789AB} /qn; Remove-Item -Recurse -Force C:\\Users\\joe\\AppData\\Roaming\\loopMIDI; Remove-Item -Recurse -Force C:\\ProgramData\\Blender'";
const CODE = "```powershell\n" + LONG_CMD + "\n```";
const REPLY =
  "Run this one. It's the second card, and it raises its own UAC prompt:\n\n" + CODE + "\n\n"
  + "It uninstalls Blender, loopMIDI, its driver and a stub MSI, then deletes `C:\\Users\\joe\\AppData\\Roaming\\Claude`. I copied it from the second card word for word, so nothing else changes on your machine.";

const tool = (tool_name: string, input: Record<string, unknown>, id: string, timestamp = 0) => [
  { type: "tool_use", tool_name, input, id, timestamp, parent_tool_use_id: null },
  { type: "tool_result", tool_use_id: id, output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 },
];
const user = (text: string) => ({ type: "user_message", content: [{ type: "text", text }], timestamp: 0 });

const HISTORY = [
  user("i see these 2 things here... am i meant to run both or just the second one?"),
  ...tool(SEND, {
    kind: "answer",
    verdict: "Run only the second one",
    question: "Am I meant to run both of the uninstall commands on the two cards, or only the second one, and does the order matter?",
    text: "Only the second one:\n\n" + CODE,
  }, "a1", AT),
  ...tool(SEND, { kind: "call", verdict: "Kept the MSI stub", text: "The stub stays until the uninstall ends:\n\n" + CODE }, "n1", AT + 5),
  // The newest closing message is the Result card's; the one before it stays a Note.
  ...tool(SEND, { kind: "call", verdict: "Left the driver alone", text: "The driver stays too:\n\n" + CODE }, "n2", AT + 6),
  ...tool("mcp__cc_conductor__report_turn_status", { status: "done" }, "t2"),
];

const THREAD = {
  id: "th1",
  created_at: 1,
  updated_at: 2,
  sidecar_session_id: "side-1",
  messages: [
    { role: "user", text: "can u send me the command again?", ts: 1 },
    { role: "assistant", text: REPLY, ts: 2 },
  ],
};
const STORE = { read: {}, threads: { a1: "th1" }, questions: [] };

async function openChat(page: Page): Promise<Locator> {
  // A laptop-sized window: the Answers card gets the dashboard's left column.
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
    },
  });
  await page.locator(`#sessions-list li[data-session-id="${SESSION.session_id}"]`).click();
  await page.waitForFunction((name) => {
    const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
    return (w.__ccListeners?.get(name)?.size ?? 0) > 0;
  }, CHANNEL);
  return page.locator("#session-pane .cdash-answers");
}

/** How far `inner`'s widest code block, and `inner` itself, reach past `outer`'s right edge. */
async function spill(outer: Locator, inner: Locator): Promise<number[]> {
  const o = (await outer.boundingBox())!;
  return inner.evaluate((el, right) => {
    const boxes = [el, ...Array.from(el.querySelectorAll("pre")).map((p) => p.closest(".shiki-wrap, .code-card") ?? p)];
    return boxes.map((b) => Math.round(b.getBoundingClientRect().right - right));
  }, o.x + o.width);
}

test("a long code block and a file chip stay inside every dashboard bubble", async ({ page }) => {
  const c = await openChat(page);

  // The answer face: the card keeps its width and its code scrolls inside.
  const face = c.locator(".ax-face");
  await expect(face.locator("pre")).toBeVisible();
  for (const s of await spill(c, c.locator(".ax-shell"))) expect(s).toBeLessThanOrEqual(1);

  // A Notes card and the Result card holding the same code stay inside their zones.
  for (const zone of ["#session-pane .cdash-notes", "#session-pane .cdash-resultcard"]) {
    const card = page.locator(zone);
    await expect(card.locator("pre").first()).toBeVisible();
    for (const m of await card.locator(".msg").all()) for (const s of await spill(card, m)) expect(s).toBeLessThanOrEqual(1);
  }

  // The thread: the body never scrolls sideways, the reply and its code fit it.
  await c.locator("[data-ax='reply']").click();
  const body = c.locator(".ax-tbody");
  const reply = body.locator(".ax-t-bub").last();
  await expect(body.locator(".ax-t-bub")).toHaveCount(2);
  await expect(reply.locator("pre")).toBeVisible();
  // Shiki highlights on its own tick; let the layout settle.
  await page.waitForTimeout(500);
  expect(await body.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  for (const s of await spill(body, reply)) expect(s).toBeLessThanOrEqual(1);

  // The file chip does not cover the words before or after it.
  const chip = reply.locator(".file-ref").first();
  await expect(chip).toBeVisible();
  const covered = await chip.evaluate((el) => {
    const c = el.getBoundingClientRect();
    const hits: string[] = [];
    const walker = document.createTreeWalker(el.closest(".ax-t-bub")!, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (el.contains(n) || !n.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of Array.from(range.getClientRects())) {
        const w = Math.min(r.right, c.right) - Math.max(r.left, c.left);
        const h = Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top);
        if (w > 1 && h > 1) hits.push(n.textContent.trim().slice(0, 30));
      }
    }
    return hits;
  });
  expect(covered).toEqual([]);

  await capture(c, "answers-thread-overflow");
});

// Joe, 2026-11-10: at 310px a thread showed about six lines of a reply and its
// question was cut to one line. It opens at 460px, the question wraps to two
// lines with the whole of it on hover, and Grow fills the window without
// losing what he typed.
test("a thread opens tall, wraps its question, and grows to the window", async ({ page }) => {
  const c = await openChat(page);
  await c.locator("[data-ax='reply']").click();
  const thread = c.locator(".ax-thread");
  await expect(thread).toBeVisible();
  await page.waitForTimeout(400);
  expect(Math.round((await thread.boundingBox())!.height)).toBe(460);

  const q = c.locator(".ax-thead-v");
  await expect(q).toHaveAttribute("title", /does the order matter\?$/);
  const lineH = await q.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 16);
  expect((await q.boundingBox())!.height).toBeGreaterThan(lineH * 1.5);

  await capture(page.locator("#session-pane"), "answers-thread-default");
  await c.locator(".ax-t-input").fill("half a follow-up");
  await c.locator("[data-ax='grow-thread']").click();
  await page.waitForTimeout(400);
  // Tall is the dashboard's visible height, so the message box stays on screen.
  const room = await page.locator("#session-pane .cdash-body").evaluate((el) => el.clientHeight);
  expect(room - 24).toBeGreaterThan(460);
  expect(Math.round((await thread.boundingBox())!.height)).toBe(room - 24);
  const comp = (await c.locator(".ax-tcomp").boundingBox())!;
  const view = (await page.locator("#session-pane .cdash-body").boundingBox())!;
  expect(comp.y + comp.height).toBeLessThanOrEqual(view.y + view.height + 1);
  await expect(c.locator(".ax-t-input")).toHaveValue("half a follow-up");
  await capture(page.locator("#session-pane"), "answers-thread-tall");

  await c.locator("[data-ax='grow-thread']").click();
  await page.waitForTimeout(400);
  expect(Math.round((await thread.boundingBox())!.height)).toBe(460);
});
