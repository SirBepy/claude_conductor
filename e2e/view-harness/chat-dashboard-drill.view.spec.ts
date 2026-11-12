// Reviewed 2026-11-12 (per-chat previews): the Preview card lists only the previews this chat pushed (newest big, the rest as a thumbnail strip) and folds the family's others behind "N more by other chats"; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-11 (Send thread to chat): an Answers-card thread with a follow-up gains a hand-off button under its latest reply, the dashboard wires its send through sendRevision, and AnswerAuthor carries the sub's id; nothing this spec asserts changed, and it passes.
// asserts: src/shared/chat/drill-links.ts, src/views/sessions/chat-dashboard/chat-dashboard.css, src/views/sessions/chat-dashboard/chat-dashboard.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// A detail link ("How it looks") in a dashboard card opens its popup. The popup
// is sized for the transcript, and the dashboard's body clips sideways, so it
// has to fit the dashboard column and stay inside the body to be readable.

const SESSION = sessionInstance();
const CHANNEL = `chat:${SESSION.session_id}`;
const SEND = "mcp__cc_conductor__send_message";

const BODY = Array.from({ length: 30 }, (_, i) => `- row ${i + 1} of how it looks`).join("\n");
const HISTORY = [
  { type: "user_message", content: [{ type: "text", text: "show me how it looks" }], timestamp: 0 },
  { type: "tool_use", tool_name: SEND, id: "t1", timestamp: 0, parent_tool_use_id: null, input: {
    kind: "report", verdict: "Done", tone: "good", done: ["The card is in"],
    text: "The card is in.",
    details: [{ id: "look", label: "How it looks", body_md: BODY }],
  } },
  { type: "tool_result", tool_use_id: "t1", output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 },
];

async function openDash(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 860 });
  await mountView(page, {
    view: "sessions",
    chatView: "dashboard",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      load_history_page: { events: HISTORY, oldest_seq: 0, newest_seq: HISTORY.length, has_more: false },
    },
  });
  await page.locator(`#sessions-list li[data-session-id="${SESSION.session_id}"]`).click();
  await page.waitForFunction((name) => {
    const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
    return (w.__ccListeners?.get(name)?.size ?? 0) > 0;
  }, CHANNEL);
}

test("the popup closes when the dashboard body scrolls or the window resizes, instead of being stranded", async ({ page }) => {
  await openDash(page, 1280);
  const open = async (): Promise<void> => {
    if (!(await page.locator("#session-pane .cdash .mc-more[open]").count())) await page.locator("#session-pane .cdash .mc-more > summary").first().click();
    await page.locator("#session-pane .cdash .drill-chip").first().click();
    await expect(page.locator("#session-pane .cdash .drill-pop")).toHaveCount(1);
  };
  await open();
  await page.evaluate(() => document.querySelector(".cdash-body")!.dispatchEvent(new Event("scroll")));
  await expect(page.locator(".drill-pop")).toHaveCount(0);
  await open();
  await page.setViewportSize({ width: 1100, height: 860 });
  await expect(page.locator(".drill-pop")).toHaveCount(0);
});

for (const width of [1280, 760]) {
  test(`the detail popup is fully visible inside the dashboard body at ${width}px`, async ({ page }) => {
    await openDash(page, width);
    // The chip sits behind the report's counts row until that is opened.
    await page.locator("#session-pane .cdash .mc-more > summary").first().click();
    await page.locator("#session-pane .cdash .drill-chip").first().click();
    const pop = page.locator("#session-pane .cdash .drill-pop");
    await expect(pop).toContainText("row 1 of how it looks");
    const m = await pop.evaluate((el) => {
      const body = el.closest(".cdash-body")!.getBoundingClientRect();
      const c = el.getBoundingClientRect();
      const t = el.querySelector(".drill-pop-title")!.getBoundingClientRect();
      return {
        inside: c.left >= body.left && c.right <= body.right && c.top >= body.top && c.bottom <= body.bottom,
        titleVisible: t.width > 0 && t.left >= body.left && t.right <= body.right,
        w: Math.round(c.width),
      };
    });
    expect(m.inside).toBe(true);
    expect(m.titleVisible).toBe(true);
    // Hit-test the popup's centre: nothing else may paint over it or clip it.
    const hit = await pop.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!top && el.contains(top);
    });
    expect(hit).toBe(true);
    await capture(page.locator("#session-pane"), `chat-dashboard-drill-${width}`);
  });
}
