// Reviewed 2026-11-23 (Done card on a main chat): a main chat's finished features are now drawn as Done lines by done-lines-card.ts, and the Done zone draws a constant host for them; nothing this spec asserts changed, and it passes in the run of every dependent spec.
// asserts: src/views/sessions/chat-dashboard/features-card.ts, src/views/sessions/chat-dashboard/features-html.ts, src/views/sessions/chat-dashboard/features-card.css, src/shared/chat/dashboard/features-model.ts, src/shared/chat/dashboard/dashboard-model.ts, src/views/sessions/chat-dashboard/plan-card.ts, src/views/sessions/chat-dashboard/sub-kinds.ts, src/views/sessions/chat-dashboard/sub-composer.ts, src/views/sessions/chat-dashboard/sub-hover.ts, src/views/sessions/chat-dashboard/subs-source.ts, src/views/sessions/chat-dashboard/chat-dashboard.ts, src/shared/chat/chat-kinds.ts, src/shared/tracker-icons.ts
import { test, expect, type Page } from "@playwright/test";
import { capture, invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance, userMsg } from "./harness";

// The merged Plan card on a project's main chat: one line per feature (its todo or ticket, or its
// task name), a trail of one kind icon per chat coloured by that chat's state, the todo and ticket
// ids as icons under the name, a fixed time column, and an opened line that shows one chat's plan
// with the latest picture inside it and that chat's reply box. The Subchats and Attachments cards
// give way to it on a main chat, with a chat in progress or none; a line's ids unfold with the line.

const CWD = "C:/Projects/cv-site";
const MIN = 60_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
type Over = Parameters<typeof sessionInstance>[0];
const chat = (id: string, name: string, pid: number, over: Over = {}) => sessionInstance({ session_id: id, name, pid, cwd: CWD, ...over });
const sub = (id: string, name: string, pid: number, over: Over = {}) =>
  chat(id, name, pid, { subchat_of: "main", busy: false, awaiting: null, started_at: ago(12 * MIN), ...over });

const PLAN = [
  { text: "Read the brief", status: "done" }, { text: "Write the card", status: "done" }, { text: "Render it", status: "active" },
  { text: "Verify", status: "pending" },
] as const;

const MAIN = chat("main", "CV redesign", 101);
const BUILD = sub("sub-build", "pc-1804 build lanes", 102, { subchat_finished: true, awaiting: "done", started_at: ago(50 * MIN), progress: { plan: null, state_since: ago(30 * MIN) } });
const REVIEW = sub("sub-review", "pc-1804 review lanes", 103, { busy: true, started_at: ago(20 * MIN), progress: { plan: [...PLAN] as never, state_since: ago(2 * MIN) } });
const ASKING = sub("sub-ask", "pc-1804 fix lanes", 104, { awaiting: "question", started_at: ago(5 * MIN) });
const TICKET = sub("sub-ticket", "sc-56709 invite modal", 105, { busy: true, started_at: ago(8 * MIN), progress: { plan: [...PLAN] as never, state_since: ago(MIN) } });
const QUEUED = sub("sub-queued", "Contact form", 106, { started_at: null as never, progress: { plan: null, state_since: null, waiting_for: "Invite modal" } as never });

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const HISTORY = [userMsg("build the lanes")];
const SESSIONS = [MAIN, BUILD, REVIEW, ASKING, TICKET, QUEUED];

function invokeFor(extra: Record<string, unknown> = {}) {
  return {
    ...SESSIONS_BASE_INVOKE,
    list_instances: SESSIONS,
    get_active_sessions: SESSIONS,
    list_subchats_on: ["main"],
    load_history_page: { events: HISTORY, oldest_seq: 0, newest_seq: HISTORY.length, has_more: false },
    context_status: { model: "claude-opus-5", window: 1_000_000, occupancy: 340_000, remaining: 660_000, pct_used: 34, pct_left: 66 },
    list_subchat_cards: [],
    list_session_images: { images: [{ id: "i1" }] },
    dashboard_gallery_image: PNG,
    get_sub_brief: { brief: { task: "Wire the contact form", goal: "Match the mock", done_when: "Tests green", kind: "build" } },
    list_previews: [],
    set_sub_pinned: null, freeze_session: null, unfreeze_session: null, cancel_turn: null, send_message: null, detach_window: null,
    ...extra,
  };
}

async function openMain(page: Page, extra: Record<string, unknown> = {}): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mountView(page, { view: "sessions", chatView: "dashboard", invoke: invokeFor(extra) });
  await page.locator(`#sessions-list li[data-session-id="main"]`).click();
  await page.locator("#session-pane .cdash").waitFor();
}

const plan = (page: Page) => page.locator("#session-pane .cdash-plan");
const feat = (page: Page, key: string) => plan(page).locator(`.pf-feat[data-feat="${key}"]`);

test.describe("chat dashboard / merged Plan card on a main chat", () => {
  test("replaces the Subchats and Attachments cards with one line per feature", async ({ page }) => {
    await openMain(page);
    await expect(plan(page)).toHaveClass(/is-features/);
    await expect(page.locator("#session-pane .cdash-subs")).toHaveCount(0);
    await expect(page.locator("#session-pane .cdash-links")).toHaveCount(0);
    // Queued first, then the rest by when they started.
    expect(await plan(page).locator(".pf-feat").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.feat))).toEqual([
      "task:contact form", "todo:pc-1804", "ticket:sc-56709",
    ]);
    // The name is words only; the ids are icons.
    await expect(feat(page, "todo:pc-1804").locator(".pf-rmain")).toHaveText("Build lanes");
    await expect(feat(page, "todo:pc-1804").locator('.pf-lk[data-act="pf-todo"]')).toHaveCount(1);
    await expect(feat(page, "ticket:sc-56709").locator(".pf-lk svg")).toHaveCount(1);
    await expect(feat(page, "task:contact form").locator(".pf-ago")).toHaveText("Queued");
  });

  test("a line's todo and ticket icons stay folded away until the line is opened", async ({ page }) => {
    await openMain(page);
    const f = feat(page, "ticket:sc-56709");
    await expect(f.locator(".pf-ids")).toHaveCSS("visibility", "hidden");
    await expect(f.locator(".pf-ids")).toHaveCSS("opacity", "0");
    await f.locator(".pf-row").click();
    await expect(f.locator(".pf-ids")).toHaveCSS("visibility", "visible");
    await expect(f.locator(".pf-ids")).toHaveCSS("opacity", "1");
    await f.locator(".pf-row").click();
    await expect(f.locator(".pf-ids")).toHaveCSS("visibility", "hidden");
  });

  test("a line with one chat opens that chat's plan and its reply box", async ({ page }) => {
    await openMain(page);
    const f = feat(page, "ticket:sc-56709");
    await f.locator(".pf-row").click();
    await expect(f.locator(".pf-body")).toHaveCount(1);
    await expect(f.locator(".pf-body .pf-slot")).toHaveCount(1);
  });

  test("rows are compact: a line without ids is no taller than 36px", async ({ page }) => {
    await openMain(page);
    const h = await feat(page, "task:contact form").locator(".pf-row").evaluate((e) => e.getBoundingClientRect().height);
    expect(h).toBeLessThanOrEqual(36);
  });

  test("a trail icon per chat, coloured by that chat's state, with the name only on hover", async ({ page }) => {
    await openMain(page);
    const icons = feat(page, "todo:pc-1804").locator(".pf-ti");
    await expect(icons).toHaveCount(3);
    expect((await icons.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.st))).sort()).toEqual(["asking", "done", "working"]);
    const colour = (i: number) => icons.nth(i).evaluate((e) => getComputedStyle(e).color);
    const cols = [await colour(0), await colour(1), await colour(2)];
    expect(new Set(cols).size).toBe(3);
    // The trail ends at one x on every line, and the time column is a fixed 66px.
    const rights = await plan(page).locator(".pf-row").evaluateAll((rows) => rows.map((r) => (r.querySelector(".pf-trail") as HTMLElement).getBoundingClientRect().right));
    expect(Math.max(...rights) - Math.min(...rights)).toBeLessThan(1);
    expect(await plan(page).locator(".pf-when").first().evaluate((e) => e.getBoundingClientRect().width)).toBe(66);
    // Hover reads the chat's state and step.
    await feat(page, "todo:pc-1804").locator('.pf-ti[data-chat="sub-review"]').hover();
    await expect(page.locator('.sx-hover-card[data-sub="sub-review"]')).toContainText("Step 3 of 4");
  });

  test("opening a feature shows one chat's plan, a trail icon picks the chat, steps are read only", async ({ page }) => {
    await openMain(page);
    const f = feat(page, "todo:pc-1804");
    await f.locator(".pf-row").click();
    await expect(f.locator(".pf-body")).toHaveCount(1);
    // The asking chat is the one shown first.
    await expect(f.locator(".pf-body")).toHaveAttribute("data-chat", "sub-ask");
    await expect(f.locator(".pf-ask")).toContainText("Needs your answer");
    await f.locator('.pf-ti[data-chat="sub-review"]').click();
    await expect(f.locator(".pf-body")).toHaveAttribute("data-chat", "sub-review");
    await expect(f.locator(".pf-steps .cdash-step-l")).toHaveText(["Read the brief", "Write the card", "Render it", "Verify"]);
    await expect(f.locator(".pf-steps .cdash-step").first()).toHaveCSS("cursor", "default");
    // The reply box is the chat's own composer.
    await expect(f.locator(".pf-slot .composer-textarea")).toHaveCount(1);
    // A second click on the line shuts it again.
    await f.locator(".pf-row").click();
    await expect(f.locator(".pf-body")).toHaveCount(0);
  });

  test("a queued feature says what it waits on and draws no reply box", async ({ page }) => {
    await openMain(page);
    const f = feat(page, "task:contact form");
    await f.locator(".pf-row").click();
    await expect(f.locator(".pf-wait")).toContainText("Waits for Invite modal");
    await expect(f.locator(".pf-slot .composer-textarea")).toHaveCount(0);
  });

  test("right-click on a trail icon opens the same chat menu a sub has everywhere", async ({ page }) => {
    await openMain(page);
    await feat(page, "todo:pc-1804").locator('.pf-ti[data-chat="sub-review"]').click({ button: "right" });
    await expect(page.locator(".sx-menu .smore-item", { hasText: "Pause" })).toBeVisible();
    await page.locator(".sx-menu .smore-item", { hasText: "Pause" }).click();
    await expect.poll(async () => (await invokeCalls(page)).filter((c) => c.cmd === "freeze_session").length).toBe(1);
  });

  test("the latest picture sits inside the opened plan in the thumbnail frame", async ({ page }) => {
    await openMain(page);
    const f = feat(page, "ticket:sc-56709");
    await f.locator(".pf-row").click();
    const pic = f.locator(".pf-plan-wrap .pf-pic");
    await expect(pic).toHaveCount(1);
    await expect(pic.locator(".cdash-ithumb")).toBeVisible();
    await capture(plan(page), "chat-dashboard-features-card");
  });

  test("a main chat whose subs have all finished still draws the merged Plan card, with no lines and no Attachments card", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const only = [MAIN, BUILD];
    // A picture in the chat is what the Attachments card lists.
    const withLink = [userMsg("the login screen as it is now", PNG)];
    const history = { events: withLink, oldest_seq: 0, newest_seq: withLink.length, has_more: false };
    await mountView(page, { view: "sessions", chatView: "dashboard", invoke: { ...invokeFor({ load_history_page: history }), list_instances: only, get_active_sessions: only } });
    await page.locator(`#sessions-list li[data-session-id="main"]`).click();
    await page.locator("#session-pane .cdash").waitFor();
    await expect(plan(page)).toHaveClass(/is-features/);
    await expect(plan(page).locator(".cdash-h-t")).toHaveText("Plan");
    await expect(plan(page).locator(".pf-feat")).toHaveCount(0);
    await expect(plan(page).locator(".cdash-pnone")).toHaveText("No chats in progress.");
    await expect(page.locator("#session-pane .cdash-links")).toHaveCount(0);
    await expect(page.locator("#session-pane .cdash-subs")).toHaveCount(0);
    // The finished feature is on the Done card.
    await expect(page.locator("#session-pane .cdash-done .dl-feat")).toHaveCount(1);
    await capture(plan(page), "chat-dashboard-plan-empty");
  });

  test("the Plan card is the header and the lines only; the resting line sits above the message box", async ({ page }) => {
    await openMain(page);
    await expect(plan(page).locator(".cdash-pnav, .cdash-steps, .cdash-plan-lead, .cdash-result, .cdash-rsum, .cdash-status, .cdash-pstatus")).toHaveCount(0);
    const idle = page.locator("#session-pane .cdash-idle");
    await expect(idle).toBeVisible();
    await expect(idle).toContainText(/Idle|Waiting on your answer/);
    // Above the message box, in the pane's own column, not inside the dashboard.
    expect(await idle.evaluate((e) => !e.closest(".cdash") && e.nextElementSibling?.classList.contains("session-composer"))).toBe(true);
  });
});
