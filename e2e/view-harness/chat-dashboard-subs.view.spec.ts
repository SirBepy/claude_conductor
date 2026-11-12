// Reviewed 2026-11-12 (Compact now): the chat menu gained a Compact now item; the sub card menu and pinned-sub shortcut this spec drives are unchanged and it passes.
// Reviewed 2026-11-10 (stale question cards): the answer card announces itself so the dashboard leaves the question open by the message box out of Waiting on you, Skip settles its transcript card in place, a reopen swaps to the daemon prompt only when it asks the same, and Skip marks naming an old daemon id fall back to time matching; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-10 (dash lane 3, code-check fixes): comment rewording, a transport case split and a deleted unused getter; nothing this spec asserts changed.
// asserts: src/views/sessions/chat-dashboard/subs-card.ts, src/views/sessions/chat-dashboard/subs-source.ts, src/views/sessions/chat-dashboard/sub-card-menu.ts, src/views/sessions/chat-dashboard/subs-card.css, src/shared/chat/dashboard/subs-model.ts, src/views/sessions/chat-menu-items.ts, src/views/sessions/sidebar-entries.ts, src/views/sessions/effort-battery.css, src/shared/chat/composer.ts, src/views/sessions/sessions.css
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

  test("a sub with many images opens its gallery one page at a time, never all at once", async ({ page }) => {
    await openMain(page, [MAIN, WORK], { list_session_images: { images: Array.from({ length: 40 }, (_, i) => ({ id: `img${i}` })) } });
    await av(page, "sub-work").click();
    await expect(det(page).locator(".sx-imgmore")).toHaveText("+39");
    const reads = async (): Promise<number> => (await invokeCalls(page)).filter((c) => c.cmd === "dashboard_gallery_image").length;
    const tiles = det(page).locator(".sx-gallery .sx-gal-img");
    // Only the newest image's thumbnail is read until the gallery opens.
    await expect.poll(reads).toBe(1);
    await det(page).locator(".sx-imgmore").click();
    await expect(tiles).toHaveCount(12);
    await expect.poll(reads).toBe(13);
    await expect(tiles.first().locator("img")).toHaveAttribute("src", PNG);
    await expect(det(page).locator(".sx-gal-more")).toHaveText("Show 12 more (28 left)");
    await capture(det(page), "subs-card-gallery-first-page");
    await det(page).locator(".sx-gal-more").click();
    await expect(tiles).toHaveCount(24);
    await expect.poll(reads).toBe(25);
    // The per-second redraw and the 5s refresh add no tile and no read.
    await page.waitForTimeout(1500);
    await expect(tiles).toHaveCount(24);
    expect(await reads()).toBe(25);
    await det(page).locator(".sx-gal-more").click();
    await expect(tiles).toHaveCount(36);
    // Closing and reopening keeps the drawn tiles; the label counts from them and "more" still adds.
    await det(page).locator(".sx-imgmore").click();
    await expect(det(page).locator(".sx-gallery")).toBeHidden();
    await det(page).locator(".sx-imgmore").click();
    await expect(tiles).toHaveCount(36);
    await expect(det(page).locator(".sx-gal-more")).toHaveText("Show 4 more (4 left)");
    await det(page).locator(".sx-gal-more").click();
    await expect(tiles).toHaveCount(40);
    await expect(det(page).locator(".sx-gal-more")).toHaveCount(0);
  });

  test("the message box is the chat's composer and sends to that sub", async ({ page }) => {
    await openMain(page, [MAIN, WORK, DONE]);
    await av(page, "sub-done").click();
    const box = det(page).locator(".sx-msg .composer-textarea");
    await expect(box).toBeVisible();
    // The real thing: attach button, send chip with its gesture hint, not a bare input.
    await expect(det(page).locator(".sx-msg .composer-send")).toBeVisible();
    await expect(det(page).locator(".sx-msg .composer-attach-in, .sx-msg .composer-attach").first()).toBeAttached();
    await box.fill("use the new logo");
    await box.press("Enter");
    await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "send_message").length).toBe(1);
    const call = (await invokeCalls(page)).find((c) => c.cmd === "send_message")!;
    expect(call.args).toMatchObject({ sessionId: "sub-done", blocks: [{ type: "text", text: "use the new logo" }] });
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
    await openMain(page, [MAIN, WORK, DONE], { list_slash_commands: SLASH_ENTRIES });
    await av(page, "sub-done").click();
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
    await openMain(page, [MAIN, WORK, DONE], { paste_attachment: "C:/tmp/pasted.png" });
    await av(page, "sub-done").click();
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
    expect(call.args).toMatchObject({ sessionId: "sub-done" });
    expect(blocks[0]!.text).toBe("see this");
    expect(blocks[1]!.text).toMatch(/^<file:C:\/tmp\/pasted\.png::/);
    // The upload is filed under the sub, so the image lands in its chat folder.
    const upload = (await invokeCalls(page)).find((c) => c.cmd === "paste_attachment")!;
    expect(upload.args).toMatchObject({ sessionId: "sub-done" });
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
