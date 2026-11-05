// asserts: src/shared/chat/chat-subchat-passed.ts, src/shared/chat/chat-event-handler-tools.ts, src/shared/chat/chat-event-to-message.ts, src/shared/chat/chat-pagination.ts, src/shared/chat/chat-transforms.ts, src/shared/chat/chat-message-cards.css
import { test, expect, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// "Passed to X": the quiet row a main chat shows where its agent sent Joe's
// message on to a sub, drawn from the `subchat` tool_use in the main chat's own
// transcript through the real renderer and the real chat CSS. A `list` call stays
// an ordinary quiet tool row, the row keeps its place across a reload and an
// older page, and the sub's reply card arrives after it. Desktop width and phone
// width (390px).

const SESSION = sessionInstance({ name: "Main" });
const SID = SESSION.session_id;
const CHANNEL = `chat:${SID}`;
const SUBCHAT = "mcp__cc_conductor__subchat";
const SEND = "mcp__cc_conductor__send_message";
const T0 = 1_700_000_000_000;
const MIN = 60_000;

const user = (text: string, ts: number) => ({ type: "user_message", content: [{ type: "text", text }], timestamp: ts });
const say = (id: string, ts: number, text: string) => ({
  type: "tool_use", tool_name: SEND, input: { kind: "report", verdict: "Done", text, done: ["x"] }, id, timestamp: ts, parent_tool_use_id: null,
});
const call = (id: string, ts: number, input: Record<string, unknown>) => ({
  type: "tool_use", tool_name: SUBCHAT, input, id, timestamp: ts, parent_tool_use_id: null,
});
const result = (id: string, ts: number, body: unknown, isError = false) => ({
  type: "tool_result", tool_use_id: id, output: { type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }, is_error: isError, timestamp: ts,
});

const subCard = (id: string, ts: number, name: string) => ({
  id, ts, parent_id: SID, kind: "finish", sub_id: `sub-${name}`, sub_name: name, round: 1,
  verdict: "Built, not pushed", tone: null, text: `Report from ${name}`, points: [], done: ["Done"], not_done: [], waiting_on: [], your_move: [],
  facts: null, sum: null, set_key: null,
});

const SENT = [
  user("nice, do the same for signup", T0),
  call("p1", T0 + MIN, { action: "send", sub: "head" }),
  result("p1", T0 + MIN + 1, { ok: true, passed_to: ["Header"], message: "Joe's message, word for word" }),
  say("m1", T0 + 2 * MIN, "Passed it on"),
];

async function mountChat(page: Page, width: number, events: unknown[], cards: unknown[] = [], olderPage?: unknown[]): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      load_history_page: { events, oldest_seq: 10, newest_seq: events.length, has_more: olderPage !== undefined },
      list_subchat_cards: cards,
    },
  });
  if (olderPage) {
    await page.evaluate((older) => {
      const core = (window as unknown as { __TAURI__: { core: { invoke: (c: string, a?: { beforeSeq?: number }) => Promise<unknown> } } }).__TAURI__.core;
      const orig = core.invoke;
      core.invoke = (cmd, args) => (cmd === "load_history_page" && args?.beforeSeq !== undefined
        ? Promise.resolve({ events: older, oldest_seq: 1, newest_seq: 5, has_more: false })
        : orig(cmd, args));
    }, olderPage);
  }
  await page.locator(`#sessions-list li[data-session-id="${SID}"]`).click();
  await page.waitForFunction((name) => {
    const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
    return (w.__ccListeners?.get(name)?.size ?? 0) > 0;
  }, CHANNEL);
}

const chat = (page: Page) => page.locator("#session-pane .session-messages");
const passed = (page: Page) => chat(page).locator(".msg.passed-row");
const order = (page: Page) =>
  chat(page).locator(".passed-row, .mc-root").evaluateAll((els) =>
    els.map((e) => ((e as HTMLElement).classList.contains("passed-row") ? "passed" : (e as HTMLElement).dataset.subCard ? "sub" : "main")));

for (const vp of [{ name: "desktop", width: 900 }, { name: "phone", width: 390 }]) {
  test.describe(`Passed to X at ${vp.name} width`, () => {
    test("a send shows one quiet row naming the sub that really got it, and a list call shows none", async ({ page }) => {
      const events = [
        ...SENT,
        call("l1", T0 + 3 * MIN, { action: "list" }),
        result("l1", T0 + 3 * MIN + 1, { ok: true, subs: [{ name: "Header", status: "working" }] }),
        call("s1", T0 + 4 * MIN, { action: "status", sub: "Header" }),
        result("s1", T0 + 4 * MIN + 1, { ok: true, name: "Header" }),
      ];
      await mountChat(page, vp.width, events);
      await expect(passed(page)).toHaveCount(1);
      // The agent typed a prefix ("head"); the row says who really got it.
      await expect(passed(page).first()).toHaveText("Passed to Header");
      await expect(passed(page).first().locator("b")).toHaveText("Header");
      // list/status stay ordinary tool rows, which quiet mode hides.
      const narration = chat(page).locator(".msg.chat-narration");
      expect(await narration.count()).toBeGreaterThanOrEqual(2);
      await expect(passed(page).first()).toBeVisible();
      const box = await passed(page).first().boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width + 1);
      await capture(chat(page), `passed-row-${vp.name}`);
    });

    test("a send to all says all running subs", async ({ page }) => {
      await mountChat(page, vp.width, [
        user("Slack says we ship Friday", T0),
        call("p1", T0 + MIN, { action: "send", all: true }),
        result("p1", T0 + MIN + 1, { ok: true, passed_to: ["Header", "Footer"] }),
      ]);
      await expect(passed(page)).toHaveText("Passed to all running subs");
    });

    test("a refused send is not shown as passed", async ({ page }) => {
      await mountChat(page, vp.width, [
        user("do the same for signup", T0),
        call("p1", T0 + MIN, { action: "send", sub: "Foo" }),
        result("p1", T0 + MIN + 1, "\"Foo\" matches more than one sub (Footer, Foo bar)", true),
      ]);
      await expect(passed(page)).toHaveText("Could not pass to Foo");
      await expect(passed(page)).toHaveClass(/passed-row--failed/);
    });

    test("the row keeps its place across a reload, with the sub's reply card after it", async ({ page }) => {
      const cards = [subCard("c1", T0 + 5 * MIN, "Header")];
      await mountChat(page, vp.width, SENT, cards);
      expect(await order(page)).toEqual(["passed", "main", "sub"]);
      await page.reload();
      await mountChat(page, vp.width, SENT, cards);
      expect(await order(page)).toEqual(["passed", "main", "sub"]);
      await expect(passed(page)).toHaveCount(1);
    });

    test("an older page draws its row in its own place too", async ({ page }) => {
      const older = [
        user("fix the nav as well", T0 - 60 * MIN),
        call("p0", T0 - 59 * MIN, { action: "send", sub: "Nav" }),
        result("p0", T0 - 59 * MIN + 1, { ok: true, passed_to: ["Nav"] }),
      ];
      await mountChat(page, vp.width, SENT, [subCard("c1", T0 + 5 * MIN, "Header")], older);
      await expect(passed(page)).toHaveCount(2);
      await expect(passed(page).nth(0)).toHaveText("Passed to Nav");
      await expect(passed(page).nth(1)).toHaveText("Passed to Header");
      expect(await order(page)).toEqual(["passed", "passed", "main", "sub"]);
    });
  });
}
