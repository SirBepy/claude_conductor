// Reviewed 2026-11-23 (merged Plan card, tracker marks): a ticket link row draws its tracker's outline mark instead of the plain ticket glyph, and the new test below pins it; every other row is unchanged.
// Reviewed 2026-11-21 (Run card and opened sub view tabs): chat-dashboard.ts, dashboard-zones.ts, dashboard-extras.css and subs-card.ts changed for the Run card's after names and the sub view's Plan and Attachments tabs; nothing this spec asserts changed, and it passes (run of every dependent spec).
// Reviewed 2026-11-21 (Attachments tabs run Previews, Images, Files, Links; file rows show the name only; the card keeps one height): the links test opens on Files, the strip test expects the new order, and a new test pins the constant height.
// Reviewed 2026-11-20 (pc-1805, Links and files became the Attachments card with Links, Files, Previews and Images tabs, and the Preview card is its Previews tab): the preview test reads rows in the Previews tab, a new test covers the Images tab, and the links test expects four tabs; the rest is unchanged.
// Reviewed 2026-11-17: the chat dashboard's Finished subchats tray became the Done card (one row per task); nothing this spec asserts changed, and it passes (run of every dependent spec).
// Reviewed 2026-11-15: the chat dashboard gained an Autopilot picks zone that draws only once a chat recorded a pick; nothing this spec asserts changed, and it passes (full run of the dependent specs).
// Reviewed 2026-11-14 (pc-1745, Links and files is a tabbed, scrollable list of rows): the card's test opens the Files tab before reading the file rows; the rest is unchanged.
// Reviewed 2026-11-14 (pc-1746, a relative link in a quick view opens that file in the dialog instead of navigating the webview): the memory test now clicks the index link; the rest is unchanged.
// Reviewed 2026-11-14 (Result card, finished tray): the Result is its own card under Plan, finished subs sit in a tray under it and the From subs card is gone; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-13 (From subs): the dashboard gained a From subs zone in the left column that draws sub reports which are not answers; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-13 (stale blockers): Waiting on you drops an own blocker once the chat sends a later report, answer, plan or same-target blocker, each Waiting card gains a written time and a hover x (Clear all once two can go) kept per chat in localStorage, and the card copy button is hidden there; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-12 (shown badly): chat-dashboard.ts adds a contextmenu listener for the card menu's "Shown badly" item (chat-shown-badly.view.spec.ts covers it); nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-12 (honest sub states): subs gained queued/paused/usage-limit/stopped kinds with a dim ring and glyph, an avatar hover card, the Plan foot's sub counts and a glowing main-chat ring; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-12 (forever chat B2): the dashboard adds rows rebuilt from the transcript digest above the loaded page, only when the page reports older history, and the drafts store read names those rows' drafts too; this spec loads its whole chat in one page, nothing it asserts changed, and it passes.
// Reviewed 2026-11-11 (Send thread to chat): an Answers-card thread with a follow-up gains a hand-off button under its latest reply, the dashboard wires its send through sendRevision, and AnswerAuthor carries the sub's id; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-11 (plan-close): dashboard-model.ts's jobs gained an `ended` flag the Plan card uses to draw never-ticked steps as left open; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-11 (answers pending row): answers-model.ts adds a row per question handed to a sub (spawn_chat, read-only, report_back) until its answer fills it, and the dashboard passes the sub list only once it holds this chat; this spec has no hand-off, nothing it asserts changed, and it passes.
// Reviewed 2026-11-11 (dashboard Drafts card): a new left-column zone draws write_draft drafts, the draft card takes an optional version and Edit form, and the dashboard reads the drafts store; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-11 (plan-card-lifecycle): dashboard-model.ts now always draws Answers and Plan, keeps every plan as a job, and Links reads `plans`; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-10 (stale question cards): the answer card announces itself so the dashboard leaves the question open by the message box out of Waiting on you, Skip settles its transcript card in place, a reopen swaps to the daemon prompt only when it asks the same, and Skip marks naming an old daemon id fall back to time matching; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-10 (question-card-ask): the Ask panel and its strip/dial entries are gone, a question card's Ask (shown only in Dashboard view) minimizes the card and opens a thread in the Answers card, and the thread classes moved from ask-* to ax-*; nothing this spec asserts changed, and it passes.
// asserts: src/views/sessions/chat-dashboard/chat-dashboard.ts, src/views/sessions/chat-dashboard/dashboard-zones.ts, src/views/sessions/chat-dashboard/quick-view.ts, src/views/sessions/chat-dashboard/dashboard-extras.css, src/shared/chat/dashboard/dashboard-model.ts, src/shared/chat/dashboard/links-model.ts
import { test, expect, type Page } from "@playwright/test";
import { deflateSync } from "node:zlib";
import { capture, invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance, userMsg } from "./harness";

// The dashboard's extra-content cards in the real app shell (docs/chat-dashboard-design.md,
// "Extra content and quick views"): the Attachments card with its Links, Files, Previews and
// Images tabs and the Bigger plan, Decided and Project memory buttons and the read view they
// open (this chat's own previews as rows that open the panel, the family's rest folded, its
// images as rows that open the gallery), the figures drawn beside an approval question, and
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

/** A solid-colour PNG with a lighter band, as base64: real image bytes for the Images tab without a fixture file. */
function png(w: number, h: number, [r, g, b]: [number, number, number]): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer): number => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    const band = y > h * 0.35 && y < h * 0.6;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = band ? Math.min(255, r + 70) : r;
      raw[o + 1] = band ? Math.min(255, g + 70) : g;
      raw[o + 2] = band ? Math.min(255, b + 70) : b;
    }
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head[8] = 8;
  head[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

const IMAGE_HISTORY = [
  userMsg("the login screen as it is now", png(320, 200, [70, 92, 160])),
  ...tool(SEND, { kind: "artifact", text: "Compare https://github.com/acme/app/pull/42" }),
  userMsg("and the empty state", png(320, 200, [150, 80, 110])),
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
    // The card opens on the first tab in the order Previews, Images, Files, Links that has
    // something in it: this chat has no previews or images, so Files.
    await expect(card.locator(".cdash-ltab.on")).toHaveText(/Files/);
    await expect(card.locator("a.cdash-link")).toHaveCount(0);
    await expect(card.locator(".file-ref[data-path='C:\\\\proj\\\\src\\\\trello.ts']")).toBeVisible();
    await expect(card.locator(".file-ref[data-path='C:\\\\proj\\\\docs\\\\notes.md']")).toBeVisible();
    // A file row shows the file name only; the full path stays in the tooltip.
    await expect(card.locator(".cdash-frow .file-ref-name")).toHaveText(["notes.md", "trello.ts"]);
    await expect(card.locator(".cdash-llist")).not.toContainText("proj");
    await expect(card.locator(".file-ref[data-path='C:\\\\proj\\\\src\\\\trello.ts']")).toHaveAttribute("title", "C:\\proj\\src\\trello.ts");
    await card.locator("[data-act='links-tab'][data-tab='links']").click();
    await expect(card.locator("a.cdash-link")).toHaveCount(2);
    await expect(card.locator("a.cdash-link").first()).toContainText("CI run 9001");
    await expect(card.locator("a.cdash-link").nth(1)).toContainText("PR #42");
    await expect(card.locator("[data-act='quick-view']")).toHaveText(["Bigger plan", "Decided", "Project memory"]);
    // The list is bounded and scrolls inside the card.
    expect(await card.locator(".cdash-llist").evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");
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
    // The index's own link opens that file in the dialog and never navigates the
    // app's webview away from the chats window (pc-1746).
    const urlBefore = page.url();
    await dlg.locator(".cdash-qvm-file").nth(0).click();
    await dlg.locator(".cdash-qvm-doc a", { hasText: "Fact A" }).click();
    await expect(dlg.locator(".cdash-qvm-doc")).toContainText("The board id lives next to the Shortcut one.");
    expect(page.url()).toBe(urlBefore);
    const asked = (await invokeCalls(page)).filter((c) => c.cmd === "chat_quick_view");
    expect(asked.some((c) => (c.args as { view?: string }).view === "memory" && (c.args as { sessionId?: string }).sessionId === SESSION.session_id)).toBe(true);
  });

  test("a ticket link row draws its tracker's mark, any other link keeps its glyph", async ({ page }) => {
    const events = [
      user("link the work"),
      ...tool(SEND, { kind: "artifact", text: "Story https://app.shortcut.com/acme/story/12345/x and issue https://linear.app/acme/issue/ENG-9/t and PR https://github.com/acme/app/pull/3" }),
    ];
    await openChat(page, { load_history_page: { events, oldest_seq: 0, newest_seq: events.length, has_more: false } });
    const card = dash(page).locator(".cdash-links");
    await card.locator("[data-act='links-tab'][data-tab='links']").click();
    const tickets = card.locator("a.cdash-link[data-link-kind='ticket']");
    await expect(tickets).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
      await expect(tickets.nth(i).locator("svg.cdash-tk")).toHaveCount(1);
      await expect(tickets.nth(i).locator("i.ph-ticket")).toHaveCount(0);
    }
    await expect(card.locator("a.cdash-link[data-link-kind='pr'] i.ph-git-pull-request")).toHaveCount(1);
  });

  test("the Previews tab lists only this chat's previews as rows, newest first, and folds the sub's away", async ({ page }) => {
    const SUB = sessionInstance({ session_id: "sub-1", name: "Hero gradient", pid: 202, subchat_of: SESSION.session_id });
    await openChat(page, {
      list_instances: [SESSION, SUB],
      get_active_sessions: [SESSION, SUB],
      list_previews: [meta("s1", { session_id: SUB.session_id }), meta("p3"), meta("p2"), meta("p1")],
    });
    const card = dash(page).locator(".cdash-links");
    await expect(card).toBeVisible();
    await expect(card.locator("[data-act='links-tab'][data-tab='previews']")).toHaveText("Previews3");
    // Previews is the first tab, so a chat with previews opens on it.
    await expect(card.locator(".cdash-ltab.on")).toHaveText(/Previews/);
    await card.locator("[data-act='links-tab'][data-tab='previews']").click();
    await expect(card.locator(".cdash-ltab.on")).toHaveText(/Previews/);
    // The list fades in over --motion-fast after a tab switch; measure once it has settled.
    await expect(card.locator(".cdash-llist.is-in")).toHaveCount(0);
    await expect(card.locator(".cdash-prow .cdash-lname")).toHaveText(["Mockup p3", "Mockup p2", "Mockup p1"]);
    await expect(card.locator(".cdash-prow[data-slug='slug-s1']")).toHaveCount(0);
    await expect(card.locator(".cdash-pv-frame").first()).toHaveAttribute("src", /^data:text\/html/);
    // Each row's picture is the page in miniature, not a full-size frame.
    const tile = (await card.locator(".cdash-pv-tile").first().boundingBox())!;
    const frame = (await card.locator(".cdash-pv-frame").first().boundingBox())!;
    expect(tile.width).toBeLessThan(90);
    expect(Math.abs(frame.width - tile.width)).toBeLessThan(6);
    // Hovering a row moves nothing (ui-polish: nothing reflows on hover).
    const row = card.locator(".cdash-prow").first();
    const at = (await row.boundingBox())!;
    await row.hover();
    const hovered = (await row.boundingBox())!;
    for (const k of ["x", "y", "width", "height"] as const) expect(Math.abs(hovered[k] - at[k])).toBeLessThan(0.5);
    // A row with its own colour on hover and a visible ring for the keyboard.
    expect(await row.evaluate((el) => getComputedStyle(el).transitionProperty)).toContain("background");
    await row.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    expect(await row.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none");

    const fold = card.locator("[data-act='pv-others']");
    await expect(fold).toContainText("1 more by other chats");
    await capture(pane(page), "chat-dashboard-previews-tab");
    await fold.click();
    await expect(card.locator(".cdash-pv-owner")).toHaveText("Hero gradient");
    await expect(card.locator(".cdash-pv-group .cdash-prow")).toHaveAttribute("data-slug", "slug-s1");
    await capture(pane(page), "chat-dashboard-previews-others-open");
    await card.locator(".cdash-prow").first().click();
    await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "get_preview").length).toBeGreaterThan(1);
  });

  test("the Images tab lists the chat's images newest first and opens the gallery at the one clicked", async ({ page }) => {
    await openChat(page, { load_history_page: { events: IMAGE_HISTORY, oldest_seq: 0, newest_seq: IMAGE_HISTORY.length, has_more: false } });
    const card = dash(page).locator(".cdash-links");
    await expect(card.locator("[data-act='links-tab'][data-tab='images']")).toHaveText("Images2");
    await card.locator("[data-act='links-tab'][data-tab='images']").click();
    await expect(card.locator(".cdash-ltab.on")).toHaveText(/Images/);
    const rows = card.locator(".cdash-irow");
    await expect(rows).toHaveCount(2);
    await expect(rows.first().locator(".cdash-lmeta")).toHaveText("You attached");
    // The thumbnails are real pictures, not empty boxes.
    await expect.poll(() => rows.first().locator("img").evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const tab = card.locator(".cdash-ltab.on");
    expect(await tab.evaluate((el) => getComputedStyle(el).transitionProperty)).toContain("color");
    await capture(pane(page), "chat-dashboard-images-tab");
    await rows.nth(1).click();
    const gallery = page.locator(".chat-image-gallery-overlay");
    await expect(gallery).toBeVisible();
    await expect(gallery.locator(".gallery-total-counter")).toContainText("1");
    await capture(page, "chat-dashboard-images-gallery");
    await page.keyboard.press("Escape");
    await expect(gallery).toHaveCount(0);
  });

  test("the tab strip keeps every tab, muted when empty, and scrolls sideways at a narrow dashboard", async ({ page }) => {
    await openChat(page, { load_history_page: { events: IMAGE_HISTORY, oldest_seq: 0, newest_seq: IMAGE_HISTORY.length, has_more: false }, list_previews: [meta("p1")] });
    const card = dash(page).locator(".cdash-links");
    await expect(card.locator("[data-act='links-tab']")).toHaveText(["Previews1", "Images2", "Files0", "Links1"]);
    // The empty Files tab stays, muted, so the strip never reshuffles.
    await expect(card.locator("[data-act='links-tab'][data-tab='files']")).toHaveClass(/is-empty/);
    expect(await card.locator(".cdash-ltabs").evaluate((el) => getComputedStyle(el).overflowX)).toBe("auto");
    await card.locator("[data-act='links-tab'][data-tab='images']").click();
    // The incoming list's one-shot fade class leaves at animationend, so no later class change replays it.
    await expect(card.locator(".cdash-llist.is-in")).toHaveCount(0);
    await page.setViewportSize({ width: 560, height: 860 });
    await expect(card.locator(".cdash-ltab").last()).toBeVisible();
    await capture(pane(page), "chat-dashboard-attachments-narrow");
  });

  test("the Attachments card keeps one height on every tab, empty or full", async ({ page }) => {
    await openChat(page, { load_history_page: { events: IMAGE_HISTORY, oldest_seq: 0, newest_seq: IMAGE_HISTORY.length, has_more: false }, list_previews: [meta("p1")] });
    const card = dash(page).locator(".cdash-links");
    await expect(card.locator(".cdash-ltab.on")).toHaveText(/Previews/);
    const heights: number[] = [];
    for (const tab of ["previews", "images", "files", "links"]) {
      await card.locator(`.cdash-ltab[data-tab='${tab}']`).click();
      await expect(card.locator(".cdash-llist.is-in")).toHaveCount(0);
      heights.push((await card.boundingBox())!.height);
    }
    // Files is empty here and Previews holds one row: the card is the same height on both.
    for (const h of heights) expect(Math.abs(h - heights[0]!)).toBeLessThan(0.5);
    await card.locator(".cdash-ltab[data-tab='files']").click();
    await expect(card.locator(".cdash-lnone")).toBeVisible();
    await capture(pane(page), "chat-dashboard-attachments-empty-tab");
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
