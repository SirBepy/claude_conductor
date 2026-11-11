// asserts: src/views/sessions/chat-dashboard/chat-dashboard.ts, src/views/sessions/chat-dashboard/dashboard-zones.ts, src/views/sessions/chat-dashboard/dashboard-extras.css, src/shared/chat/dashboard/dashboard-model.ts, src/shared/chat/dashboard/drafts-model.ts, src/shared/chat/chat-draft-card.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// The Drafts card in the real app shell (docs/chat-dashboard-design.md, "Drafts"):
// messages Claude wrote for Joe to send elsewhere (write_draft), one card per
// draft in the left column, the newest open, with Copy and Edit; copied ones
// fold under "N copied".

const SESSION = sessionInstance();
const CHANNEL = `chat:${SESSION.session_id}`;
const DRAFT_TOOL = "mcp__cc_conductor__write_draft";

const variant = (recipient: string, body: string, n = 1, author = "ai") => ({
  recipient, handle_n: 1, current: n,
  versions: [{ n, body, author, note: "", created_at: "" }],
  person: null, platform: null, sent: false,
});
const stored = (id: string, topic: string, v: ReturnType<typeof variant>, state = "needs-you") => ({
  id, topic, brief: "", receipts: [], variants: [v], state, origin_session_id: SESSION.session_id, origin_label: "", created_at: "", updated_at: "", seen_by_origin: true,
});

const LIV = stored("c", "Weekly status", variant("Liv", "Hi Liv,\n\nThis week: Trello links are done and ship Thursday.", 2), "copied");
const BRUNO = stored("a", "When v0.2.150 lands", variant("Bruno", "Hey Bruno, v0.2.150 goes out **Thursday the 14th** around noon.\n\nIt carries the Trello links you asked about. I'll ping you when it's live."));
const SC = stored("b", "Fix shipped", variant("sc-1234", "Fixed in v0.2.150 (out Thursday the 14th).\n\nThe hover card now waits for the board to confirm the card id. Moving this to Ready for QA.", 2, "user"));

let n = 0;
const draft = (input: Record<string, unknown>, d: unknown, id = `w${++n}`) => [
  { type: "tool_use", tool_name: DRAFT_TOOL, input, id, timestamp: 0, parent_tool_use_id: null },
  { type: "tool_result", tool_use_id: id, output: { type: "text", text: JSON.stringify({ ok: true, draft: d }) }, is_error: false, timestamp: 0 },
];
const user = (text: string) => ({ type: "user_message", content: [{ type: "text", text }], timestamp: 0 });

const HISTORY = [
  user("draft liv's weekly status"),
  ...draft({ action: "add", topic: "Weekly status", recipient: "Liv", body: "Hi Liv" }, LIV),
  user("draft a slack reply to bruno about when the release lands, and a comment on sc-1234 saying it's fixed"),
  ...draft({ action: "add", topic: "When v0.2.150 lands", recipient: "Bruno", body: "Hey Bruno" }, BRUNO),
  ...draft({ action: "add", topic: "Fix shipped", recipient: "sc-1234", body: "Fixed" }, SC),
];

async function openChat(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 860 });
  await mountView(page, {
    view: "sessions",
    chatView: "dashboard",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      get_settings: { theme: "void", chatView: "dashboard" },
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      load_history_page: { events: HISTORY, oldest_seq: 0, newest_seq: HISTORY.length, has_more: false },
      answers_state: { read: {}, threads: {}, questions: [] },
      ask_list_threads: [],
      list_previews: [],
      list_message_drafts: { drafts: [LIV, BRUNO, SC] },
      set_draft_state: null,
    },
  });
  await page.locator(`#sessions-list li[data-session-id="${SESSION.session_id}"]`).click();
  await page.waitForFunction((name) => {
    const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
    return (w.__ccListeners?.get(name)?.size ?? 0) > 0;
  }, CHANNEL);
}

const card = (page: Page) => page.locator("#session-pane .cdash-left .cdash-drafts");

test.describe("chat dashboard Drafts card", () => {
  test("lists each draft once, newest open, with Copy and Edit, and folds the copied one", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openChat(page);
    const c = card(page);
    await expect(c).toBeVisible();
    await expect(c.locator(".cdash-count")).toHaveText("2 to send");
    const rows = c.locator(".msg.draft-card");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toHaveClass(/open/);
    await expect(rows.first().locator(".dc-to")).toHaveText("sc-1234 #1");
    await expect(rows.first().locator(".dc-ver")).toHaveText("v2 · your edit");
    await expect(rows.nth(1)).not.toHaveClass(/open/);
    await expect(c.locator("[data-act='drafts-copied']")).toContainText("1 copied");
    // The card fills the column, unlike the transcript's centred 90% card.
    const [cardBox, rowBox] = [await c.boundingBox(), await rows.first().boundingBox()];
    expect(rowBox!.width).toBeGreaterThan(cardBox!.width - 40);
    await capture(page.locator("#session-pane"), "chat-dashboard-drafts-card");

    // Edit hands the draft to the Drafts panel.
    await page.evaluate(() => {
      const w = window as unknown as { __opened: string[] };
      w.__opened = [];
      window.addEventListener("cc-draft-open", (e) => w.__opened.push((e as CustomEvent<{ id: string }>).detail.id));
    });
    await rows.first().locator("[data-draft-pop]").click();
    expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toEqual(["b"]);

    // Copy marks it copied in the store.
    await rows.first().locator("[data-draft-copy]").click();
    await expect.poll(async () => (await invokeCalls(page)).some((x) => x.cmd === "set_draft_state" && (x.args as { id?: string }).id === "b")).toBe(true);

    // The chevron opens the older one; the copied fold opens on a click.
    await rows.nth(1).locator("[data-draft-toggle]").click();
    await expect(card(page).locator(".msg.draft-card").nth(1)).toHaveClass(/open/);
    await card(page).locator("[data-act='drafts-copied']").click();
    await expect(card(page).locator(".msg.draft-card.copied")).toHaveCount(1);
  });
});
