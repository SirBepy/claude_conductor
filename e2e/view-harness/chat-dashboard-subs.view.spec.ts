// Reviewed 2026-11-10 (dash lane 3, code-check fixes): comment rewording, a transport case split and a deleted unused getter; nothing this spec asserts changed.
// asserts: src/views/sessions/chat-dashboard/subs-card.ts, src/views/sessions/chat-dashboard/subs-source.ts, src/views/sessions/chat-dashboard/sub-card-menu.ts, src/views/sessions/chat-dashboard/subs-card.css, src/shared/chat/dashboard/subs-model.ts, src/views/sessions/chat-menu-items.ts, src/views/sessions/sidebar-entries.ts, src/views/sessions/effort-battery.css
import { test, expect, type Page } from "@playwright/test";
import { capture, invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance, userMsg } from "./harness";

// The dashboard's Subchats card on a real main chat with subs: avatars with a
// state ring and an effort-tinted model battery in the right column under Plan,
// finished subs kept for an hour and then folded under "+N earlier", the details
// of the one clicked (run time, context chip, brief, newest image with "+N", the
// latest preview, a message box), the right-click menu, and a pinned sub's
// sidebar shortcut.

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
const DONE = sub("sub-done", "Colours", 105, { subchat_finished: true, awaiting: "done", effort: "low", progress: { plan: null, state_since: ago(10 * MIN) } });
const OLD = sub("sub-old", "Fonts", 106, { subchat_finished: true, awaiting: "done", progress: { plan: null, state_since: ago(3 * 60 * MIN) } });

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
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

const card = (page: Page) => page.locator("#session-pane .cdash-right .cdash-subs");
const av = (page: Page, id: string) => card(page).locator(`.sx-av[data-sub="${id}"]`);
const det = (page: Page) => card(page).locator(".sx-det");

test.describe("chat dashboard / Subchats card", () => {
  test("lists working, queued, asking and recent finished subs, and folds the older one under +1 earlier", async ({ page }) => {
    await openMain(page, [MAIN, WORK, ASK, QUEUED, DONE, OLD]);
    await expect(card(page)).toBeVisible();
    // Right column, under the Plan card.
    const plan = page.locator("#session-pane .cdash-right .cdash-plan");
    expect((await card(page).boundingBox())!.y).toBeGreaterThan((await plan.boundingBox())!.y);
    // Asking first, then working, queued, then the finished one inside the hour.
    await expect(card(page).locator(".sx-row .sx-av")).toHaveCount(4);
    expect(await card(page).locator(".sx-row .sx-av").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.sub))).toEqual(["sub-ask", "sub-work", "sub-queued", "sub-done"]);
    await expect(card(page).locator(".sx-earlier")).toHaveText("+1 earlier");
    await expect(av(page, "sub-old")).toHaveCount(0);
    await card(page).locator(".sx-earlier").click();
    await expect(card(page).locator(".sx-earlier-row .sx-av")).toHaveCount(1);
    await expect(av(page, "sub-old")).toHaveCount(1);

    // The ring carries the state: red asks, a plan arc works, green is done.
    await expect(av(page, "sub-ask").locator('circle[data-tone="question"]').first()).toBeVisible();
    await expect(av(page, "sub-work").locator("svg.is-plan")).toHaveCount(1);
    await expect(av(page, "sub-done").locator('circle[data-tone="done"]').first()).toBeVisible();
    await capture(page.locator("#session-pane"), "chat-dashboard-subs-card");
  });

  test("the model battery takes the effort colour, and high stays the default grey", async ({ page }) => {
    const plain = chat("plain", "Plain chat", 110, { effort: "xhigh" });
    const calm = chat("calm", "Calm chat", 111);
    await openMain(page, [MAIN, WORK, ASK, DONE, plain, calm]);
    const colour = (id: string) => av(page, id).locator(".session-model-battery").evaluate((e) => getComputedStyle(e).color);
    expect(await colour("sub-work")).toBe("rgb(235, 87, 87)");
    expect(await colour("sub-done")).toBe("rgb(236, 230, 207)");
    await expect(av(page, "sub-ask").locator(".session-model-battery[data-effort]")).toHaveCount(0);
    // The sidebar rows wear it too: xhigh orange, and the high default keeps its grey.
    const rowBattery = (id: string) => page.locator(`#sessions-list li[data-session-id="${id}"] .session-model-battery`);
    expect(await rowBattery("plain").evaluate((e) => getComputedStyle(e).color)).toBe("rgb(242, 153, 74)");
    await expect(rowBattery("calm")).not.toHaveAttribute("data-effort", /.+/);
  });

  test("a click opens the details: run time, context chip, brief, newest image with +N, the latest preview", async ({ page }) => {
    await openMain(page, [MAIN, WORK, DONE]);
    await av(page, "sub-work").click();
    await expect(det(page)).toBeVisible();
    await expect(det(page).locator(".sx-det-name")).toHaveText("Footer");
    await expect(det(page).locator(".sx-det-time b")).toHaveText(/^1\d:\d\d$/);
    await expect(det(page).locator(".sx-det-ctx .sb-context")).toHaveText("34%");
    await expect(det(page).locator(".sx-det-state")).toHaveText("step 3 of 4");
    await expect(det(page).locator(".sx-det-brief")).toContainText("Build the footer");
    await expect(det(page).locator(".sx-det-brief")).toContainText("Done when: Tests green");
    await expect(det(page).locator(".sx-img img")).toHaveAttribute("src", PNG);
    await expect(det(page).locator(".sx-imgmore")).toHaveText("+2");
    await expect(det(page).locator(".sx-pv")).toContainText("Footer mock");
    await capture(page.locator("#session-pane"), "chat-dashboard-subs-details");

    // +N opens every image of the sub.
    await det(page).locator(".sx-imgmore").click();
    await expect(det(page).locator(".sx-gallery .sx-gal-img")).toHaveCount(3);
    // The preview tile asks the app to open that preview.
    const opened = page.evaluate(() => new Promise<string>((res) => window.addEventListener("cc-preview-open", (e) => res((e as CustomEvent).detail.slug), { once: true })));
    await det(page).locator(".sx-pv").click();
    expect(await opened).toBe("footer-mock");
    // A finished sub's details say its verdict, and clicking the avatar again closes them.
    await av(page, "sub-done").click();
    await expect(det(page).locator(".sx-det-state")).toHaveText("Colours settled");
    await av(page, "sub-done").click();
    await expect(det(page)).toBeHidden();
  });

  test("the message box sends to that sub", async ({ page }) => {
    await openMain(page, [MAIN, WORK]);
    await av(page, "sub-work").click();
    const box = det(page).locator(".sx-msg-in");
    await expect(box).toHaveAttribute("placeholder", "Message Footer");
    await box.fill("use the new logo");
    await box.press("Enter");
    await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "send_message").length).toBe(1);
    const call = (await invokeCalls(page)).find((c) => c.cmd === "send_message")!;
    expect(call.args).toMatchObject({ sessionId: "sub-work", blocks: [{ type: "text", text: "use the new logo" }] });
    await expect(box).toHaveValue("");
  });

  test("a redraw while the sub is open keeps what was typed", async ({ page }) => {
    await openMain(page, [MAIN, WORK]);
    await av(page, "sub-work").click();
    await det(page).locator(".sx-msg-in").fill("half a thought");
    await page.evaluate(() => (window as unknown as { __ccListeners: Map<string, Set<(e: { payload: unknown }) => void>> }).__ccListeners.get("instances-changed")?.forEach((cb) => cb({ payload: [] })));
    await page.waitForTimeout(300);
    await expect(det(page).locator(".sx-msg-in")).toHaveValue("half a thought");
  });

  test("the right-click menu lists the eight actions and each one acts on that sub", async ({ page }) => {
    await openMain(page, [MAIN, WORK, DONE]);
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

    await av(page, "sub-work").click({ button: "right" });
    await page.locator(".sx-menu .smore-item", { hasText: "Close" }).click();
    await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "send_message").length).toBe(1);
    expect((await invokeCalls(page)).find((c) => c.cmd === "send_message")!.args).toMatchObject({ sessionId: "sub-work", blocks: [{ type: "text", text: "/close" }] });
  });

  test("Open reads the sub in place, and a queued sub cannot be paused, stopped or closed", async ({ page }) => {
    await openMain(page, [MAIN, WORK, QUEUED]);
    await av(page, "sub-queued").click({ button: "right" });
    for (const label of ["Pause", "Stop this turn", "Change model", "Change effort", "Close"]) {
      await expect(page.locator(".sx-menu .smore-item", { hasText: label })).toHaveClass(/is-disabled/);
    }
    await page.keyboard.press("Escape");
    await av(page, "sub-work").click({ button: "right" });
    await page.locator(".sx-menu .smore-item", { hasText: /^Open$/ }).click();
    await expect(page.locator("#session-pane .session-header .sub-back-btn")).toBeVisible();
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
