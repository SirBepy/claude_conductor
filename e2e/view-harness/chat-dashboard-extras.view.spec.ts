// Reviewed 2026-11-11 (Send thread to chat): an Answers-card thread with a follow-up gains a hand-off button under its latest reply, the dashboard wires its send through sendRevision, and AnswerAuthor carries the sub's id; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-11 (plan-close): dashboard-model.ts's jobs gained an `ended` flag the Plan card uses to draw never-ticked steps as left open; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-11 (answers pending row): answers-model.ts adds a row per question handed to a sub (spawn_chat, read-only, report_back) until its answer fills it, and the dashboard passes the sub list only once it holds this chat; this spec has no hand-off, nothing it asserts changed, and it passes.
// Reviewed 2026-11-11 (dashboard Drafts card): a new left-column zone draws write_draft drafts, the draft card takes an optional version and Edit form, and the dashboard reads the drafts store; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-11 (plan-card-lifecycle): dashboard-model.ts now always draws Answers and Plan, keeps every plan as a job, and Links reads `plans`; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-10 (stale question cards): the answer card announces itself so the dashboard leaves the question open by the message box out of Waiting on you, Skip settles its transcript card in place, a reopen swaps to the daemon prompt only when it asks the same, and Skip marks naming an old daemon id fall back to time matching; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-10 (question-card-ask): the Ask panel and its strip/dial entries are gone, a question card's Ask (shown only in Dashboard view) minimizes the card and opens a thread in the Answers card, and the thread classes moved from ask-* to ax-*; nothing this spec asserts changed, and it passes.
// asserts: src/views/sessions/chat-dashboard/chat-dashboard.ts, src/views/sessions/chat-dashboard/dashboard-zones.ts, src/views/sessions/chat-dashboard/quick-view.ts, src/views/sessions/chat-dashboard/dashboard-extras.css, src/shared/chat/dashboard/dashboard-model.ts, src/shared/chat/dashboard/links-model.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// The dashboard's extra-content cards in the real app shell (docs/chat-dashboard-design.md,
// "Extra content and quick views"): Links and files with the Bigger plan, Decided
// and Project memory buttons and the read view they open, the Preview window tile
// that opens the preview panel, the figures drawn beside an approval question, and
// the Changes card that only exists once Joe switches it on.

const SESSION = sessionInstance();
const CHANNEL = `chat:${SESSION.session_id}`;
const SEND = "mcp__cc_conductor__send_message";

let n = 0;
const tool = (tool_name: string, input: Record<string, unknown>, id = `t${++n}`) => [
  { type: "tool_use", tool_name, input, id, timestamp: 0, parent_tool_use_id: null },
  { type: "tool_result", tool_use_id: id, output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 },
];
const user = (text: string) => ({ type: "user_message", content: [{ type: "text", text }], timestamp: 0 });

const HISTORY = [
  user("fix the trello board id and open a PR"),
  ...tool("mcp__cc_conductor__write_plan", { steps: [
    { text: "Fix the board id", status: "done" },
    { text: "Open the PR", status: "active" },
  ] }),
  ...tool("Edit", { file_path: "C:\\proj\\src\\trello.ts", old_string: "a", new_string: "b" }),
  ...tool(SEND, {
    kind: "artifact",
    text: "PR is up: https://github.com/acme/app/pull/42\nCI: https://github.com/acme/app/actions/runs/9001\nSee C:\\proj\\docs\\notes.md",
  }),
  ...tool(SEND, {
    kind: "call", verdict: "Two ways to store it", text: "Compare them.",
    visuals: [{ type: "table", title: "Storage", columns: ["Option", "Cost"], rows: [["Settings", "low"], ["Own file", "high"]] }],
  }),
  { type: "tool_use", tool_name: "mcp__cc_conductor__ask_user_question", input: { questions: [{ question: "Which storage?", options: [{ label: "Settings" }, { label: "Own file" }] }] }, id: "ask1", timestamp: 0, parent_tool_use_id: null },
];

const MOCKUP = "data:text/html,<body style='margin:0;background:%23123;color:%23fff;font:48px sans-serif'><h1>Comparison</h1><table border=1><tr><td>A</td><td>B</td></tr></table></body>";

const meta = (id: string, over: Record<string, unknown> = {}) => ({
  id, slug: `slug-${id}`, title: `Mockup ${id}`, source: "chat", session_id: SESSION.session_id, version: 1,
  created_at: "2026-11-10T10:00:00Z", published: null, versions: [], shared: false, ...over,
});

/** The harness mock answers a command with one fixed value, and the three quick
 *  views need three different ones, so chat_quick_view is answered by a wrapper
 *  put around the mock the moment it is installed. */
async function answerQuickViews(page: Page, byView: Record<string, unknown>): Promise<void> {
  await page.addInitScript((answers) => {
    let real: { core: { invoke: (cmd: string, args?: { view?: string }) => Promise<unknown> } } | undefined;
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      get: () => real,
      set: (v) => {
        const orig = v.core.invoke;
        v.core.invoke = (cmd: string, args?: { view?: string }) => {
          if (cmd !== "chat_quick_view") return orig(cmd, args);
          // The mock still sees the call (its record is what specs assert on); its rejection is ignored.
          void orig(cmd, args).catch(() => {});
          return Promise.resolve((answers as Record<string, unknown>)[args?.view ?? ""]);
        };
        real = v;
      },
    });
  }, byView);
}

async function openChat(page: Page, extra: Record<string, unknown> = {}, settings: Record<string, unknown> = {}): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 860 });
  await mountView(page, {
    view: "sessions",
    chatView: "dashboard",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      get_settings: { theme: "void", chatView: "dashboard", ...settings },
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      load_history_page: { events: HISTORY, oldest_seq: 0, newest_seq: HISTORY.length, has_more: false },
      answers_state: { read: {}, threads: {}, questions: [] },
      ask_list_threads: [],
      list_previews: [],
      get_preview: { id: "p2", html: "<h1>Comparison</h1>" },
      render_preview_doc: MOCKUP,
      ...extra,
    },
  });
  await page.locator(`#sessions-list li[data-session-id="${SESSION.session_id}"]`).click();
  await page.waitForFunction((name) => {
    const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
    return (w.__ccListeners?.get(name)?.size ?? 0) > 0;
  }, CHANNEL);
}

const dash = (page: Page) => page.locator("#session-pane .cdash");
const pane = (page: Page) => page.locator("#session-pane");

const QUICK = {
  plan: { view: "plan", title: "Bigger plan", docs: [], message: "This project has no bigger plan: .claude/todos/PLAN.md does not exist." },
  decided: { view: "decided", title: "Decided", docs: [], message: "Nothing decided yet: this chat has no decisions log." },
  memory: { view: "memory", title: "Project memory", docs: [{ name: "MEMORY.md", body: "- [Fact A](a.md) - the first fact" }, { name: "a.md", body: "# Fact A\nThe board id lives next to the Shortcut one." }], message: "" },
};

test.describe("chat dashboard extra cards", () => {
  test("Links and files lists the PR, CI run and files, and the quick views open a read view", async ({ page }) => {
    await answerQuickViews(page, QUICK);
    await openChat(page);
    const card = dash(page).locator(".cdash-links");
    await expect(card).toBeVisible();
    await expect(card.locator("a.cdash-link")).toHaveCount(2);
    await expect(card.locator("a.cdash-link").first()).toContainText("CI run 9001");
    await expect(card.locator("a.cdash-link").nth(1)).toContainText("PR #42");
    await expect(card.locator(".file-ref[data-path='C:\\\\proj\\\\src\\\\trello.ts']")).toBeVisible();
    await expect(card.locator(".file-ref[data-path='C:\\\\proj\\\\docs\\\\notes.md']")).toBeVisible();
    await expect(card.locator("[data-act='quick-view']")).toHaveText(["Bigger plan", "Decided", "Project memory"]);
    // Nothing behind Bigger plan or Decided: both read muted, Project memory does not.
    await expect(card.locator("[data-view='plan']")).toHaveClass(/is-none/);
    await expect(card.locator("[data-view='decided']")).toHaveClass(/is-none/);
    await expect(card.locator("[data-view='memory']")).not.toHaveClass(/is-none/);
    await capture(pane(page), "chat-dashboard-links-card");

    await card.locator("[data-view='decided']").click();
    const dlg = page.locator(".cdash-qvm");
    await expect(dlg.locator(".cdash-qvm-none")).toContainText("Nothing decided yet");
    await page.keyboard.press("Escape");
    await expect(dlg).toHaveCount(0);

    await card.locator("[data-view='plan']").click();
    await expect(dlg.locator(".cdash-qvm-none")).toContainText("no bigger plan");
    await dlg.locator(".cdash-qvm-x").click();

    await card.locator("[data-view='memory']").click();
    await expect(dlg.locator(".cdash-qvm-file")).toHaveText(["MEMORY.md", "a.md"]);
    await dlg.locator(".cdash-qvm-file").nth(1).click();
    await expect(dlg.locator(".cdash-qvm-doc")).toContainText("The board id lives next to the Shortcut one.");
    await capture(page, "chat-dashboard-memory-view");
    const asked = (await invokeCalls(page)).filter((c) => c.cmd === "chat_quick_view");
    expect(asked.some((c) => (c.args as { view?: string }).view === "memory" && (c.args as { sessionId?: string }).sessionId === SESSION.session_id)).toBe(true);
  });

  test("the Preview window card shows the newest preview as a tile that opens the panel", async ({ page }) => {
    await openChat(page, { list_previews: [meta("p2"), meta("p1")] });
    const card = dash(page).locator(".cdash-preview");
    await expect(card).toBeVisible();
    await expect(card.locator(".cdash-pv-title")).toHaveText("Mockup p2");
    await expect(card.locator(".cdash-pv-more")).toContainText("+1 more");
    await expect(card.locator(".cdash-pv-frame")).toHaveAttribute("src", /^data:text\/html/);
    // The tile is a miniature of the page, not a full-size frame.
    const tile = (await card.locator(".cdash-pv-tile").boundingBox())!;
    const frame = (await card.locator(".cdash-pv-frame").boundingBox())!;
    expect(Math.abs(frame.width - tile.width)).toBeLessThan(6);
    await capture(pane(page), "chat-dashboard-preview-tile");
    await card.locator(".cdash-pv-tile").click();
    await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "get_preview").length).toBeGreaterThan(1);
  });

  test("the question in Waiting on you carries the table of the message that came with it", async ({ page }) => {
    await openChat(page);
    const waiting = dash(page).locator(".cdash-waiting");
    await expect(waiting.locator(".cdash-figs table")).toBeVisible();
    await expect(waiting.locator(".cdash-figs")).toContainText("Settings");
    await expect(waiting.locator(".question-card")).toBeVisible();
    await capture(pane(page), "chat-dashboard-question-figures");
  });

  test("Changes exists but is off by default", async ({ page }) => {
    await openChat(page);
    await expect(dash(page).locator(".cdash-links")).toBeVisible();
    await expect(dash(page).locator(".cdash-changes")).toHaveCount(0);
  });

  test("with Changes switched on it lists the edited file, and with Links switched off that card is gone", async ({ page }) => {
    await openChat(page, {}, { dashboardSections: { changes: true, links: false } });
    await expect(dash(page).locator(".cdash-changes .file-ref")).toHaveAttribute("data-path", "C:\\proj\\src\\trello.ts");
    await expect(dash(page).locator(".cdash-changes")).toContainText("1 edit");
    await expect(dash(page).locator(".cdash-links")).toHaveCount(0);
    await capture(pane(page), "chat-dashboard-changes-card");
  });
});
