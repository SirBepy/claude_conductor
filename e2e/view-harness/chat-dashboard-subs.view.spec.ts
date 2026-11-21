// Reviewed 2026-11-21 (opened sub view tabs): the peek's media row and image grid became an Attachments tab (the dashboard's own four-tab card for that sub) beside a Plan tab; the cases below that drove the old thumbnail, "+N" and grid were rewritten for it.
// Reviewed 2026-11-21 (put away, pc-1806 step 5): a project's main chat that the daemon put away (hidden_at) joins the Hidden view with a Paused badge, opens read-only, and its Close reads Put away; nothing this spec asserts changed (its chats carry no hidden_at), and it passes in the run of every spec that depends on those files.
// Reviewed 2026-11-20 (V2 priority badge): the head's ring and per-head count became one top-right badge by priority and the daemon keeps a viewed mark; nothing this spec asserts changed. It passes.
// Reviewed 2026-11-19 (pc-1789, the lightbox steps through a group of images with arrows, buttons and a swipe): the peek still draws its grid the same way and only the image click now hands the lightbox a list; run after the change and it passes.
// Reviewed 2026-11-14 (pc-1740, the sidebar project filter rail and the phone Filter by project submenu are removed): nothing this spec asserts changed; run after the change and it passes.
// Reviewed 2026-11-12: closeChat now resolves true or false instead of nothing and its callers ignore it; nothing this spec asserts changed (not run here).
// Reviewed 2026-11-12 (Compact now): the chat menu gained a Compact now item; the sub card menu and pinned-sub shortcut this spec drives are unchanged and it passes.
// Reviewed 2026-11-12 (project main chat): the sidebar lists one Main chats row per project and the sessions mount re-reads each project's main-chat pointer; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-10 (stale question cards): the answer card announces itself so the dashboard leaves the question open by the message box out of Waiting on you, Skip settles its transcript card in place, a reopen swaps to the daemon prompt only when it asks the same, and Skip marks naming an old daemon id fall back to time matching; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-10 (dash lane 3, code-check fixes): comment rewording, a transport case split and a deleted unused getter; nothing this spec asserts changed.
// asserts: src/views/sessions/chat-dashboard/subs-card.ts, src/views/sessions/chat-dashboard/sub-peek.ts, src/shared/chat/dashboard/peek-attachments.ts, src/views/sessions/chat-dashboard/dashboard-zones.ts, src/views/sessions/chat-dashboard/dashboard-extras.css, src/views/sessions/chat-dashboard/subs-source.ts, src/views/sessions/chat-dashboard/sub-card-menu.ts, src/views/sessions/chat-menu-items.ts, src/views/sessions/close-chat.ts, src/views/sessions/chat-dashboard/subs-card.css, src/shared/chat/dashboard/subs-model.ts, src/views/sessions/chat-heads.ts, src/views/sessions/effort-battery.css, src/shared/chat/composer.ts, src/views/sessions/sessions.css
import { test, expect, type Page } from "@playwright/test";
import { capture, invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance, userMsg } from "./harness";

// The dashboard's Subchats card on a real main chat with subs, in the left column under Waiting
// on you: a tinted row with its reason for every sub that needs Joe or is stuck, a strip of avatars
// (state ring, effort-tinted model battery) for the working ones (a finished sub is not here: it
// waits in the Done card, see chat-dashboard-sub-reports.view.spec.ts), a floating card per
// clicked sub that can be dragged and kept open beside others (run time, context chip, a Plan tab
// with the step and brief and an Attachments tab with that sub's previews, images, files and links,
// and a message box), the right-click menu, and a pinned sub's sidebar shortcut.

const CWD = "C:/Projects/cv-site";
const MIN = 60_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
type Over = Parameters<typeof sessionInstance>[0];
const chat = (id: string, name: string, pid: number, over: Over = {}) => sessionInstance({ session_id: id, name, pid, cwd: CWD, ...over });
const sub = (id: string, name: string, pid: number, over: Over = {}) =>
  chat(id, name, pid, { subchat_of: "main", busy: false, awaiting: null, started_at: ago(12 * MIN), ...over });

const PLAN = [
  { text: "Read", status: "done" }, { text: "Write", status: "done" }, { text: "Render", status: "active" },
  { text: "Verify", status: "pending" },
] as const;

const MAIN = chat("main", "CV redesign", 101);
const WORK = sub("sub-work", "Footer", 102, { busy: true, effort: "max", progress: { plan: [...PLAN] as never, state_since: ago(2 * MIN) } });
const ASK = sub("sub-ask", "Header", 103, { awaiting: "question" });
const QUEUED = sub("sub-queued", "Contact form", 104, { progress: { plan: null, state_since: null, waiting_for: "Footer" } as never });
// Idle with no finish reads "stopped": the one live kind whose message box sends at once instead of holding the message.
const STOP = sub("sub-stop", "Colours", 105, { effort: "low", progress: { plan: null, state_since: ago(10 * MIN) } });
const DONE = sub("sub-done", "Fonts", 106, { subchat_finished: true, awaiting: "done", progress: { plan: null, state_since: ago(10 * MIN) } });

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SLASH_ENTRIES = [
  { name: "close", args: null, description: "Session retrospective", source: { kind: "user-skill" } },
  { name: "commit", args: null, description: "Commit changes", source: { kind: "user-skill" } },
];
const SEND = "mcp__cc_conductor__send_message";
const PLAN_TOOL = "mcp__cc_conductor__write_plan";
let n = 0;
const tool = (tool_name: string, input: Record<string, unknown>, id = `t${++n}`) => [
  { type: "tool_use", tool_name, input, id, timestamp: 0, parent_tool_use_id: null },
  { type: "tool_result", tool_use_id: id, output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 },
];
const HISTORY = [
  userMsg("build the new CV site"),
  ...tool(SEND, { kind: "plan", verdict: "Four jobs", text: "Footer, header, form and colours go to subs." }),
  ...tool(PLAN_TOOL, { steps: [{ text: "Hand out the jobs", status: "done" }, { text: "Merge the results", status: "active" }] }),
];

function invokeFor(sessions: unknown[], extra: Record<string, unknown> = {}) {
  return {
    ...SESSIONS_BASE_INVOKE,
    list_instances: sessions,
    get_active_sessions: sessions,
    list_subchats_on: ["main"],
    load_history_page: { events: HISTORY, oldest_seq: 0, newest_seq: HISTORY.length, has_more: false },
    context_status: { model: "claude-opus-5", window: 1_000_000, occupancy: 340_000, remaining: 660_000, pct_used: 34, pct_left: 66 },
    list_subchat_cards: [{ id: "c1", ts: Date.now() - 10 * MIN, parent_id: "main", kind: "finish", sub_id: "sub-done", verdict: "Colours settled", tone: "good", text: "x" }],
    list_session_images: { images: [{ id: "i1" }, { id: "i2" }, { id: "i3" }] },
    dashboard_gallery_image: PNG,
    get_sub_brief: { brief: { task: "Build the footer", goal: "Match the mock", done_when: "Tests green" } },
    list_previews: [{ id: "p1", slug: "footer-mock", title: "Footer mock", source: "chat_card", session_id: "sub-work", version: 1, created_at: ago(MIN), published: null, versions: [] }],
    set_sub_pinned: null, freeze_session: null, unfreeze_session: null, cancel_turn: null, send_message: null, detach_window: null,
    ...extra,
  };
}

async function openMain(page: Page, sessions: unknown[], extra: Record<string, unknown> = {}): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mountView(page, { view: "sessions", chatView: "dashboard", invoke: invokeFor(sessions, extra) });
  await page.locator(`#sessions-list li[data-session-id="main"]`).click();
  await page.locator("#session-pane .cdash").waitFor();
}

const card = (page: Page) => page.locator("#session-pane .cdash-left .cdash-subs");
const av = (page: Page, id: string) => card(page).locator(`.sx-av[data-sub="${id}"]`);
// The newest open peek: peeks append in the order they were opened.
const det = (page: Page) => card(page).locator(".sx-det").last();
const peekOf = (page: Page, id: string) => card(page).locator(`.sx-det[data-sub="${id}"]`);
// The grow-in scales the card, so a box measured mid-animation is not its real one.
// Waits out the grow-in so the card's box is its real one (the animation scales it from the avatar).
const grown = async (peek: ReturnType<typeof peekOf>): Promise<void> => {
  await expect(peek).not.toHaveClass(/is-opening/);
  await expect(peek).toHaveCSS("transform", "none");
};

test.describe("chat dashboard / Subchats card", () => {
  test("lists asking, working, queued and stopped subs, and leaves a finished one to the Done card", async ({ page }) => {
    await openMain(page, [MAIN, WORK, ASK, QUEUED, STOP, DONE]);
    await expect(card(page)).toBeVisible();
    // Left column, under Waiting on you, never in the right column.
    await expect(page.locator("#session-pane .cdash-right .cdash-subs")).toHaveCount(0);
    // Stuck subs are rows, asking first; the working one is an avatar in the strip. A queued sub has no
    // process and is not stuck: it is the "N queued" count (chat-dashboard-queued-popup.view.spec.ts).
    await expect(card(page).locator(".sx-rows .sx-item")).toHaveCount(2);
    expect(await card(page).locator(".sx-rows .sx-item").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.sub))).toEqual(["sub-ask", "sub-stop"]);
    await expect(card(page).locator(".sx-queued")).toHaveText("1 queued");
    expect(await card(page).locator(".sx-row .sx-av").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.sub))).toEqual(["sub-work"]);
    await expect(card(page).locator(".sx-item[data-sub='sub-ask'] .sx-item-why")).toHaveText("Needs your answer");
    await expect(card(page).locator(".sx-item[data-sub='sub-stop'] .sx-item-why")).toHaveText("Stopped without finishing");
    await expect(card(page).locator(".sx-counts")).toHaveText("1 working · 1 asking · 1 stuck or waiting · 1 queued");
    await expect(av(page, "sub-done")).toHaveCount(0);
    await expect(card(page).locator(".sx-earlier")).toHaveCount(0);
    await expect(page.locator(`#session-pane .cdash-done .dn-task`)).toBeVisible();

    // The ring carries the state: red asks, a plan arc works.
    await expect(av(page, "sub-ask").locator('circle[data-tone="question"]').first()).toBeVisible();
    await expect(av(page, "sub-work").locator("svg.is-plan")).toHaveCount(1);
    await capture(page.locator("#session-pane"), "chat-dashboard-subs-card");
  });

  test("the model battery takes the effort colour, and high stays the default grey", async ({ page }) => {
    const plain = chat("plain", "Plain chat", 110, { effort: "xhigh" });
    const calm = chat("calm", "Calm chat", 111);
    await openMain(page, [MAIN, WORK, ASK, STOP, plain, calm]);
    const colour = (id: string) => av(page, id).locator(".session-model-battery").evaluate((e) => getComputedStyle(e).color);
    expect(await colour("sub-work")).toBe("rgb(235, 87, 87)");
    expect(await colour("sub-stop")).toBe("rgb(236, 230, 207)");
    await expect(av(page, "sub-ask").locator(".session-model-battery[data-effort]")).toHaveCount(0);
    // The sidebar rows wear it too: xhigh orange, and the high default keeps its grey.
    const rowBattery = (id: string) => page.locator(`#sessions-list li[data-session-id="${id}"] .session-model-battery`);
    expect(await rowBattery("plain").evaluate((e) => getComputedStyle(e).color)).toBe("rgb(242, 153, 74)");
    await expect(rowBattery("calm")).not.toHaveAttribute("data-effort", /.+/);
  });

  test("a sub opens by growing out of its avatar with its plan first and the brief as one line that unfolds", async ({ page }) => {
    await openMain(page, [MAIN, WORK, STOP]);
    await av(page, "sub-work").click();
    const d = det(page);
    await expect(d).toBeVisible();
    // The plan's steps lead, in order, with the step being worked marked.
    await expect(d.locator(".sx-det-plan li")).toHaveText(["Read", "Write", "Render", "Verify"]);
    await expect(d.locator('.sx-det-plan li[data-status="active"]')).toHaveText("Render");
    await expect(d.locator(".sx-det-step")).toBeHidden();
    // The brief is one task line that unfolds; the full text is still there.
    await expect(d.locator(".sx-det-brief summary")).toHaveText("Brief: Build the footer");
    await expect(d.locator(".sx-det-brief")).not.toHaveAttribute("open", "");
    await d.locator(".sx-det-brief summary").click();
    await expect(d.locator(".sx-det-brief")).toHaveAttribute("open", "");
    const order = await d.evaluate((el) => {
      const pane = el.querySelector(".sx-pane")!;
      const at = (sel: string) => [...pane.children].indexOf(pane.querySelector(sel)!);
      return at(".sx-det-plan") < at(".sx-det-brief");
    });
    expect(order).toBe(true);
    // It grows over 0.45s from the avatar's centre, and a plan-less sub shows its task and state.
    // (Measured on a probe: by now the card's own animation may be over.)
    expect(await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.className = "sx-det is-opening";
      document.body.appendChild(probe);
      const dur = getComputedStyle(probe).animationDuration;
      probe.remove();
      return dur;
    })).toBe("0.45s");
    expect(await d.evaluate((el) => el.style.getPropertyValue("--sx-ox"))).toMatch(/^-?\d+px$/);
    await av(page, "sub-stop").click();
    const stopped = det(page);
    await expect(stopped.locator(".sx-det-plan")).toBeHidden();
    await expect(stopped.locator(".sx-det-state")).toHaveText("stopped without finishing");
    // Closing shrinks it back (the class), then it is gone.
    await av(page, "sub-work").click();
    await expect(peekOf(page, "sub-work")).toHaveClass(/is-closing/);
    await expect(peekOf(page, "sub-work")).toHaveCount(0);
    // Opened again while a close was still shrinking: one card, never two on one sub.
    await av(page, "sub-work").click();
    await av(page, "sub-work").click();
    await av(page, "sub-work").click();
    // Counted at once: a closing card left beside the new one would still be there for 450ms.
    expect(await peekOf(page, "sub-work").count()).toBe(1);
  });

  test("a click opens the details: run time, context chip and the Plan tab with the brief", async ({ page }) => {
    await openMain(page, [MAIN, WORK, STOP]);
    await av(page, "sub-work").click();
    await expect(det(page)).toBeVisible();
    await expect(det(page).locator(".sx-det-name")).toHaveText("Footer");
    await expect(det(page).locator(".sx-det-time b")).toHaveText(/^0[23]:\d\d$/);
    await expect(det(page).locator(".sx-det-ctx .sb-context")).toHaveText("34%");
    await expect(det(page).locator(".sx-det-state")).toHaveText("step 3 of 4");
    await expect(det(page).locator(".sx-det-brief")).toContainText("Build the footer");
    await expect(det(page).locator(".sx-det-brief")).toContainText("Done when: Tests green");
    // Plan is the tab it opens on; the old thumbnail, "+N" chip and preview pill are gone from it.
    await expect(det(page).locator(".sx-tab.on")).toHaveText("Plan");
    await expect(det(page).locator(".sx-pane[data-pane='plan']")).toBeVisible();
    await expect(det(page).locator(".sx-att")).toBeHidden();
    await expect(det(page).locator(".sx-img, .sx-imgmore, .sx-pv, .sx-gallery")).toHaveCount(0);
    await capture(page.locator("#session-pane"), "chat-dashboard-subs-details");
    // A stopped sub's details say so, and clicking the avatar again closes them.
    await av(page, "sub-stop").click();
    await expect(det(page).locator(".sx-det-state")).toHaveText("stopped without finishing");
    await av(page, "sub-stop").click();
    await expect(peekOf(page, "sub-stop")).toHaveCount(0);
    // The first sub's card stayed open the whole time: peeks do not replace each other.
    await expect(peekOf(page, "sub-work")).toBeVisible();
  });

  test("the Attachments tab is the dashboard's own card for that sub: previews first, then images, files and links", async ({ page }) => {
    await openMain(page, [MAIN, WORK]);
    await av(page, "sub-work").click();
    const d = det(page);
    const tabs = d.locator(".sx-tab");
    await expect(tabs).toHaveText(["Plan", /^Attachments4$/]);
    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(d.locator(".sx-pane[data-pane='plan']")).toBeHidden();
    // The four tabs of the Attachments card, opening on the first with something in it.
    await expect(d.locator(".sx-att .cdash-ltab")).toHaveText(["Previews1", "Images3", "Files0", "Links0"]);
    await expect(d.locator(".sx-att .cdash-ltab.on")).toContainText("Previews");
    await expect(d.locator(".sx-att .cdash-prow")).toContainText("Footer mock");
    // Images: a row each, newest first, opening the lightbox on the whole list.
    await d.locator(".sx-att .cdash-ltab", { hasText: "Images" }).click();
    await expect(d.locator(".sx-att .cdash-irow")).toHaveCount(3);
    await expect(d.locator(".sx-att .cdash-irow").first().locator("img")).toHaveAttribute("src", PNG);
    await d.locator(".sx-att .cdash-irow").first().click();
    await expect(page.locator(".lightbox-counter")).toHaveText("3 / 3");
    await page.keyboard.press("Escape");
    // An empty tab says nothing in words, and the card has no heading and no quick-view buttons.
    await d.locator(".sx-att .cdash-ltab", { hasText: "Files" }).click();
    await expect(d.locator(".sx-att .cdash-lnone")).toHaveCount(0);
    await expect(d.locator(".sx-att .cdash-llist")).toHaveText("");
    await expect(d.locator(".cdash-qv, .cdash-h")).toHaveCount(0);
    // Last: a preview row asks the app to open that preview, and the panel then covers the card.
    await d.locator(".sx-att .cdash-ltab", { hasText: "Previews" }).click();
    const opened = page.evaluate(() => new Promise<string>((res) => window.addEventListener("cc-preview-open", (e) => res((e as CustomEvent).detail.slug), { once: true })));
    await d.locator(".sx-att .cdash-prow").click();
    expect(await opened).toBe("footer-mock");
  });

  test("the tab choice and the card's own tab survive the per-second redraw and the 5s refresh", async ({ page }) => {
    await openMain(page, [MAIN, WORK]);
    await av(page, "sub-work").click();
    const d = det(page);
    await d.locator(".sx-tab", { hasText: "Attachments" }).click();
    await d.locator(".sx-att .cdash-ltab", { hasText: "Images" }).click();
    await d.locator(".sx-att .cdash-irow").first().evaluate((el) => { (el as HTMLElement).dataset["probe"] = "kept"; });
    await page.waitForTimeout(6200);
    await expect(d.locator(".sx-tab.on")).toContainText("Attachments");
    await expect(d.locator(".sx-att .cdash-ltab.on")).toContainText("Images");
    // The rows were patched in place, never rebuilt (a rebuild would reload every picture).
    await expect(d.locator(".sx-att .cdash-irow").first()).toHaveAttribute("data-probe", "kept");
  });

  test("the peek's keys and clicks stay in the peek: the dashboard's own Attachments card and gallery do not follow", async ({ page }) => {
    await openMain(page, [MAIN, WORK]);
    const main = page.locator("#session-pane .cdash-right .cdash-links");
    await expect(main.locator(".cdash-ltab.on")).toBeVisible();
    const before = await main.locator(".cdash-ltab.on").innerText();
    await av(page, "sub-work").click();
    const d = det(page);
    await d.locator(".sx-tab", { hasText: "Attachments" }).click();
    await d.locator(".sx-att .cdash-ltab", { hasText: "Images" }).click();
    expect(await main.locator(".cdash-ltab.on").innerText()).toBe(before);
    // One image click opens one lightbox, on the sub's own list.
    await d.locator(".sx-att .cdash-irow").first().click();
    await expect(page.locator(".lightbox-counter")).toHaveCount(1);
    await page.keyboard.press("Escape");
    // Arrow keys step the peek's strip only.
    await d.locator(".sx-att .cdash-ltab.on").focus();
    await page.keyboard.press("ArrowRight");
    expect(await main.locator(".cdash-ltab.on").innerText()).toBe(before);
    // Space presses the focused tab; it is never typed into the message box.
    await d.locator(".sx-tab", { hasText: "Plan" }).focus();
    await page.keyboard.press("Space");
    await expect(d.locator(".sx-tab.on")).toHaveText("Plan");
    await d.locator(".sx-tab", { hasText: "Attachments" }).focus();
    await page.keyboard.press("Space");
    await expect(d.locator(".sx-tab.on")).toContainText("Attachments");
    // The relay would type into the main chat's box, so every message box on the page stays empty.
    expect(await page.locator(".composer-textarea").evaluateAll((els) => els.filter((el) => (el as HTMLTextAreaElement).value !== "").length)).toBe(0);
  });

  test("a main chat with pictures of its own never paints them into the peek's Images rows or its lightbox", async ({ page }) => {
    const B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const own = [userMsg("first", B64), userMsg("second", B64)];
    await openMain(page, [MAIN, WORK], { load_history_page: { events: own, oldest_seq: 0, newest_seq: own.length, has_more: false } });
    await av(page, "sub-work").click();
    const d = det(page);
    await d.locator(".sx-tab", { hasText: "Attachments" }).click();
    await d.locator(".sx-att .cdash-ltab", { hasText: "Images" }).click();
    await expect(d.locator(".sx-att .cdash-irow")).toHaveCount(3);
    await expect(d.locator(".sx-att .cdash-irow img").first()).toHaveAttribute("src", PNG);
    // The dashboard redraws (and hydrates its own pictures) after the rows exist.
    await page.evaluate(() => window.dispatchEvent(new Event("cc-attachment-settled")));
    await page.waitForTimeout(400);
    for (const img of await d.locator(".sx-att .cdash-irow img").all()) await expect(img).toHaveAttribute("src", PNG);
    await d.locator(".sx-att .cdash-irow").first().click();
    await expect(page.locator(".lightbox-counter")).toHaveText("3 / 3");
  });

  test("the Plan and Attachments tabs and the card's own tabs move with the arrow keys", async ({ page }) => {
    await openMain(page, [MAIN, WORK]);
    await av(page, "sub-work").click();
    const d = det(page);
    await d.locator(".sx-tab").first().focus();
    await page.keyboard.press("ArrowRight");
    await expect(d.locator(".sx-tab.on")).toContainText("Attachments");
    await expect(d.locator(".sx-tab.on")).toBeFocused();
    await d.locator(".sx-att .cdash-ltab.on").focus();
    await page.keyboard.press("ArrowRight");
    await expect(d.locator(".sx-att .cdash-ltab.on")).toContainText("Images");
    await expect(d.locator(".sx-att .cdash-ltab.on")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(d.locator(".sx-att .cdash-ltab.on")).toContainText("Previews");
  });

  test("Links and Files read what the sub's own history sent and edited", async ({ page }) => {
    const history = [
      ...tool(SEND, { kind: "report", verdict: "Done", text: "Opened https://github.com/o/r/pull/12 for review." }),
      ...tool("Edit", { file_path: "C:/Projects/cv-site/src/footer.ts" }),
    ];
    await openMain(page, [MAIN, WORK], { load_history_page: { events: history, oldest_seq: 0, newest_seq: history.length, has_more: false } });
    await av(page, "sub-work").click();
    const d = det(page);
    await d.locator(".sx-tab", { hasText: "Attachments" }).click();
    await d.locator(".sx-att .cdash-ltab", { hasText: "Links" }).click();
    await expect(d.locator(".sx-att .cdash-link")).toHaveAttribute("href", "https://github.com/o/r/pull/12");
    await d.locator(".sx-att .cdash-ltab", { hasText: "Files" }).click();
    await expect(d.locator(".sx-att .file-ref")).toHaveAttribute("data-path", "C:/Projects/cv-site/src/footer.ts");
    // The history is the sub's own, never the main chat's.
    const read = (await invokeCalls(page)).filter((c) => c.cmd === "load_history_page").map((c) => (c.args as { sessionId: string }).sessionId);
    expect(read).toContain("sub-work");
  });

  test("a sub with many images lists twelve rows and one more row, and reads a picture only for a drawn row", async ({ page }) => {
    await openMain(page, [MAIN, WORK], { list_session_images: { images: Array.from({ length: 40 }, (_, i) => ({ id: `img${i}` })) } });
    await av(page, "sub-work").click();
    const d = det(page);
    const reads = async (): Promise<number> => (await invokeCalls(page)).filter((c) => c.cmd === "dashboard_gallery_image").length;
    // The count is in, and nothing was read: the pictures wait for the tab that draws them.
    await expect(d.locator(".sx-tab", { hasText: "Attachments" })).toContainText("41");
    expect(await reads()).toBe(0);
    await d.locator(".sx-tab", { hasText: "Attachments" }).click();
    await d.locator(".sx-att .cdash-ltab", { hasText: "Images" }).click();
    await expect(d.locator(".sx-att .cdash-irow")).toHaveCount(12);
    await expect(d.locator(".sx-att .cdash-lmore")).toContainText("28 more");
    await expect.poll(reads).toBe(12);
    await capture(det(page), "subs-card-attachments-images");
    // The per-second redraw and the 5s refresh add no row and no read.
    await page.waitForTimeout(1500);
    await expect(d.locator(".sx-att .cdash-irow")).toHaveCount(12);
    expect(await reads()).toBe(12);
  });

  test("the message box is the chat's composer and sends to that sub", async ({ page }) => {
    await openMain(page, [MAIN, WORK, STOP]);
    await av(page, "sub-stop").click();
    const box = det(page).locator(".sx-msg .composer-textarea");
    await expect(box).toBeVisible();
    // The real thing: attach button, send chip with its gesture hint, not a bare input.
    await expect(det(page).locator(".sx-msg .composer-send")).toBeVisible();
    await expect(det(page).locator(".sx-msg .composer-attach-in, .sx-msg .composer-attach").first()).toBeAttached();
    await box.fill("use the new logo");
    await box.press("Enter");
    await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "send_message").length).toBe(1);
    const call = (await invokeCalls(page)).find((c) => c.cmd === "send_message")!;
    expect(call.args).toMatchObject({ sessionId: "sub-stop", blocks: [{ type: "text", text: "use the new logo" }] });
    await expect(box).toHaveValue("");

    // The send button sends too.
    await box.fill("and the footer");
    await det(page).locator(".sx-msg .composer-send").click();
    await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "send_message").length).toBe(2);
  });

  test("a message to a sub that is mid-turn is held for it instead of failing", async ({ page }) => {
    await openMain(page, [MAIN, WORK]);
    await av(page, "sub-work").click();
    const box = det(page).locator(".sx-msg .composer-textarea");
    await box.fill("when you get to it");
    await box.press("Enter");
    await expect(box).toHaveValue("");
    await expect(page.locator(".toast, #toast-host .toast").filter({ hasText: "Footer" })).toBeVisible();
    expect((await invokeCalls(page)).filter((c) => c.cmd === "send_message")).toHaveLength(0);
    // Held for that sub (the held controller files it with the daemon), where the idle sweep sends it when the turn ends.
    await expect.poll(async () => (await invokeCalls(page)).some((c) => c.cmd === "add_held_message" && (c.args as { sessionId?: string }).sessionId === "sub-work")).toBe(true);
  });

  test("typing / in the message box lists skills, and picking one inserts it", async ({ page }) => {
    await openMain(page, [MAIN, WORK, STOP], { list_slash_commands: SLASH_ENTRIES });
    await av(page, "sub-stop").click();
    const box = det(page).locator(".sx-msg .composer-textarea");
    await box.fill("/cl");
    const popup = page.locator(".caret-popup:not([hidden])");
    await expect(popup).toBeVisible();
    await expect(popup.locator(".row .head")).toHaveText("/close");
    // Not cut off by the dashboard's scrolling column it opens upward inside.
    const pop = (await popup.boundingBox())!;
    const col = (await page.locator("#session-pane .cdash-right").boundingBox())!;
    expect(pop.y).toBeGreaterThanOrEqual(col.y - 1);
    await popup.locator(".row").click();
    await expect(box).toHaveValue("/close ");
  });

  test("a pasted image attaches to the message and goes to the sub with it", async ({ page }) => {
    await openMain(page, [MAIN, WORK, STOP], { paste_attachment: "C:/tmp/pasted.png" });
    await av(page, "sub-stop").click();
    const box = det(page).locator(".sx-msg .composer-textarea");
    await box.focus();
    await page.evaluate(() => {
      const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
      const file = new File([png], "paste.png", { type: "image/png" });
      const evt = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(evt, "clipboardData", {
        value: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }], files: [file], types: ["Files"], getData: () => "" },
      });
      document.querySelector(".sx-det .sx-msg .composer-textarea")!.dispatchEvent(evt);
    });
    await expect(det(page).locator(".sx-msg .composer-attachments img")).toBeVisible();
    await box.fill("see this");
    // Previewing the image edits THIS box's draft in the caption, not the chat composer's.
    await det(page).locator(".sx-msg .composer-attachments img").click();
    await expect(page.locator(".lightbox-composer")).toHaveValue("see this");
    await page.keyboard.press("Escape");
    await expect(page.locator(".lightbox-composer")).toHaveCount(0);
    await expect(box).toHaveValue("see this");
    await box.press("Enter");
    await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "send_message").length).toBe(1);
    const call = (await invokeCalls(page)).find((c) => c.cmd === "send_message")!;
    const blocks = (call.args as { blocks: Array<{ text: string }> }).blocks;
    expect(call.args).toMatchObject({ sessionId: "sub-stop" });
    expect(blocks[0]!.text).toBe("see this");
    expect(blocks[1]!.text).toMatch(/^<file:C:\/tmp\/pasted\.png::/);
    // The upload is filed under the sub, so the image lands in its chat folder.
    const upload = (await invokeCalls(page)).find((c) => c.cmd === "paste_attachment")!;
    expect(upload.args).toMatchObject({ sessionId: "sub-stop" });
  });

  test("a keystroke aimed at nothing lands in the chat's own composer once, not in the card's box", async ({ page }) => {
    await openMain(page, [MAIN, WORK]);
    await av(page, "sub-work").click();
    // The chat's composer mounts again AFTER the card's box exists (a reselect does this), so a
    // second type-anywhere relay on the card's box would now run first and take the key.
    await page.evaluate(async () => {
      const mod = await import("/views/sessions/active-session-composer.ts");
      mod.mountComposer(document.querySelector<HTMLElement>("#session-pane")!, { session_id: "main", cwd: "C:/Projects/cv-site" } as never, "main", false);
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await page.keyboard.press("q");
    const own = page.locator("#session-pane .session-composer .composer-textarea");
    await expect(own).toHaveValue("q");
    await expect(det(page).locator(".sx-msg .composer-textarea")).toHaveValue("");
  });

  test("opening the details does not focus the message box", async ({ page }) => {
    await openMain(page, [MAIN, WORK]);
    await av(page, "sub-work").click();
    await expect(det(page).locator(".sx-msg .composer-textarea")).not.toBeFocused();
  });

  test("a redraw while the sub is open keeps what was typed", async ({ page }) => {
    await openMain(page, [MAIN, WORK]);
    await av(page, "sub-work").click();
    await det(page).locator(".sx-msg .composer-textarea").fill("half a thought");
    await page.evaluate(() => (window as unknown as { __ccListeners: Map<string, Set<(e: { payload: unknown }) => void>> }).__ccListeners.get("instances-changed")?.forEach((cb) => cb({ payload: [] })));
    await page.waitForTimeout(300);
    await expect(det(page).locator(".sx-msg .composer-textarea")).toHaveValue("half a thought");
  });

  test("the right-click menu lists the eight actions and each one acts on that sub", async ({ page }) => {
    await openMain(page, [MAIN, WORK, STOP], { clear_session: false });
    await av(page, "sub-work").click({ button: "right" });
    const menu = page.locator(".sx-menu");
    await expect(menu.locator(".smore-item")).toHaveText([
      "Open", "Open in new window", "Latest preview", "Pause", "Pin to sidemenu", "Stop this turn", "Change model", "Change effort", "Close",
    ]);
    await menu.locator(".smore-item", { hasText: "Pause" }).click();
    await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "freeze_session").length).toBe(1);
    expect((await invokeCalls(page)).find((c) => c.cmd === "freeze_session")!.args).toMatchObject({ sessionId: "sub-work" });

    await av(page, "sub-work").click({ button: "right" });
    await page.locator(".sx-menu .smore-item", { hasText: "Pin to sidemenu" }).click();
    await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "set_sub_pinned").length).toBe(1);
    expect((await invokeCalls(page)).find((c) => c.cmd === "set_sub_pinned")!.args).toMatchObject({ sessionId: "sub-work", pinned: true });

    await av(page, "sub-work").click({ button: "right" });
    await page.locator(".sx-menu .smore-item", { hasText: "Stop this turn" }).click();
    await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "cancel_turn").length).toBe(1);

    await av(page, "sub-work").click({ button: "right" });
    await page.locator(".sx-menu .smore-item", { hasText: "Open in new window" }).click();
    await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "detach_window").length).toBe(1);

    // A busy sub would first ask to discard its turn; an idle one closes at once.
    await av(page, "sub-stop").click({ button: "right" });
    await page.locator(".sx-menu .smore-item", { hasText: "Close" }).click();
    // Close ends the sub through the app's own close path; the sub is sent no message.
    await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "clear_session").length).toBe(1);
    expect((await invokeCalls(page)).find((c) => c.cmd === "clear_session")!.args).toMatchObject({ sessionId: "sub-stop" });
    expect((await invokeCalls(page)).filter((c) => c.cmd === "send_message")).toEqual([]);
  });

  test("Open reads the sub in place, and a queued sub cannot be paused, stopped or closed", async ({ page }) => {
    await openMain(page, [MAIN, WORK, QUEUED]);
    await card(page).locator(".sx-queued").click();
    await page.locator('.sq-pop .sx-av[data-sub="sub-queued"]').click({ button: "right" });
    // The items a queued sub cannot use left its top level for a nested submenu, still disabled
    // there (the queued menu itself is covered by sub-states.view.spec.ts).
    for (const label of ["Pause", "Stop this turn", "Change model", "Change effort", "Close"]) {
      await expect(page.locator(".sx-menu .smore-item", { hasText: new RegExp(`^${label}$`) })).toHaveCount(0);
    }
    await page.locator(".sx-menu .smore-item", { hasText: "Once it has started" }).click();
    for (const label of ["Pause", "Stop this turn", "Change model", "Change effort", "Close"]) {
      await expect(page.locator(".chat-menu-submenu .smore-item", { hasText: new RegExp(`^${label}$`) })).toHaveClass(/is-disabled/);
    }
    await page.keyboard.press("Escape");
    await av(page, "sub-work").click({ button: "right" });
    await page.locator(".sx-menu .smore-item", { hasText: /^Open$/ }).click();
    await expect(page.locator("#session-pane .session-header .sub-back-btn")).toBeVisible();
  });

  test("several peeks stay open at once, a click on the row opens one too, and the x closes only its own", async ({ page }) => {
    await openMain(page, [MAIN, WORK, ASK, STOP]);
    await card(page).locator(".sx-item[data-sub='sub-ask'] .sx-item-name").click();
    await av(page, "sub-work").click();
    await expect(peekOf(page, "sub-ask")).toBeVisible();
    await expect(peekOf(page, "sub-work")).toBeVisible();
    // Floating over the neighbouring column, not growing the card.
    await grown(peekOf(page, "sub-work"));
    const col = (await page.locator("#session-pane .cdash-left").boundingBox())!;
    expect((await peekOf(page, "sub-work").boundingBox())!.x).toBeGreaterThanOrEqual(col.x + col.width - 1);
    await expect(card(page).locator(".sx-item[data-sub='sub-ask']")).toHaveClass(/on/);
    await peekOf(page, "sub-ask").locator("[data-act='peek-close']").click();
    await expect(peekOf(page, "sub-ask")).toHaveCount(0);
    await expect(peekOf(page, "sub-work")).toBeVisible();
    await expect(card(page).locator(".sx-item[data-sub='sub-ask']")).not.toHaveClass(/on/);
  });

  test("a peek drags by its top line and keeps what was typed in its message box", async ({ page }) => {
    await openMain(page, [MAIN, WORK]);
    await av(page, "sub-work").click();
    const peek = peekOf(page, "sub-work");
    await grown(peek);
    await peek.locator(".sx-msg .composer-textarea").fill("half a thought");
    const before = (await peek.boundingBox())!;
    const handle = (await peek.locator(".sx-det-name").boundingBox())!;
    await page.mouse.move(handle.x + 10, handle.y + 5);
    await page.mouse.down();
    await page.mouse.move(handle.x + 70, handle.y + 85, { steps: 4 });
    await page.mouse.up();
    const after = (await peek.boundingBox())!;
    expect(Math.round(after.x - before.x)).toBe(60);
    expect(Math.round(after.y - before.y)).toBe(80);
    await expect(peek.locator(".sx-msg .composer-textarea")).toHaveValue("half a thought");
  });

  test("past five stuck rows the card shows five and a +N more button", async ({ page }) => {
    const many = Array.from({ length: 7 }, (_, i) => sub(`sub-s${i}`, `Stopped ${i}`, 120 + i, { progress: { plan: null, state_since: ago(10 * MIN) } }));
    await openMain(page, [MAIN, ...many]);
    await expect(card(page).locator(".sx-rows .sx-item")).toHaveCount(5);
    await card(page).locator(".sx-more").click();
    await expect(card(page).locator(".sx-rows .sx-item")).toHaveCount(7);
    await expect(card(page).locator(".sx-more")).toHaveText("Show fewer");
  });

  test("a chat with no subs draws no Subchats card", async ({ page }) => {
    await openMain(page, [MAIN]);
    await expect(page.locator("#session-pane .cdash-subs")).toHaveCount(0);
  });

  test("a pinned sub gets a sidebar row; an unpinned one has none", async ({ page }) => {
    await openMain(page, [MAIN, { ...WORK, pinned_to_sidebar: true }, ASK]);
    await expect(page.locator(`#sessions-list li[data-session-id="sub-work"]`)).toHaveCount(1);
    await expect(page.locator(`#sessions-list li[data-session-id="sub-ask"]`)).toHaveCount(0);
    // The pinned one reads Unpin in its menu.
    await av(page, "sub-work").click({ button: "right" });
    await expect(page.locator(".sx-menu .smore-item", { hasText: "Unpin from sidemenu" })).toBeVisible();
  });
});
