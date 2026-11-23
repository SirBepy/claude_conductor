// Reviewed 2026-11-23 (Done card on a main chat): a main chat's finished features are now drawn as Done lines by done-lines-card.ts, and the Done zone draws a constant host for them; nothing this spec asserts changed, and it passes in the run of every dependent spec.
// Reviewed 2026-11-23 (Plan card follow-ups): a main chat counts as a main chat only while a sub has not finished (so an all-finished chat keeps its Attachments card), and the Plan card keeps the chat Joe is writing to only while its box has text or focus; nothing this spec asserts changed, and it passes (run of every dependent spec).
// Reviewed 2026-11-23 (merged Plan card): a main chat's Plan card now lists its subs as feature lines and drops the Subchats and Attachments cards, and SubCardItem gained a steps list; nothing this spec asserts changed, and it passes in the run of every dependent spec.
import { test, expect, type Page } from "@playwright/test";
import { capture, fireEvent, invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance, userMsg } from "./harness";

// asserts: src/views/sessions/chat-dashboard/plan-card.ts, src/views/sessions/chat-dashboard/chat-dashboard.ts, src/views/sessions/chat-dashboard/run-card.ts, src/views/sessions/chat-dashboard/run-card.css, src/views/sessions/chat-dashboard/run-source.ts, src/shared/chat/dashboard/run-model.ts

// The run section of the dashboard's Plan card (pc-1804 step 5; Joe, 2026-11-22: one Plan card,
// no separate Run card): the plan a main chat holds with `run_plan`, as one row per chain of
// lanes and the steps after them, under the chat's own plan. It is patched in place when the
// daemon announces a change (and when the Plan card above it redraws), and a finished run can be
// cleared with a hover x.

const CWD = "C:/Projects/cv-site";
const MAIN = sessionInstance({ session_id: "main", name: "Finish todos", pid: 101, cwd: CWD });
const PLAN_TOOL = "mcp__cc_conductor__write_plan";
const planEvents = (done: number, id: string) => [
  { type: "tool_use", tool_name: PLAN_TOOL, input: { steps: ["Read todos", "Start lanes", "Review"].map((text, i) => ({ text, status: i < done ? "done" : i === done ? "active" : "pending" })) }, id, timestamp: 0, parent_tool_use_id: null },
  { type: "tool_result", tool_use_id: id, output: { type: "text", text: "{\"ok\":true}" }, is_error: false, timestamp: 0 },
];
const HISTORY = [userMsg("work through the todo list"), ...planEvents(0, "p0")];

type Over = Record<string, unknown>;
const step = (id: string, over: Over = {}): Over => ({
  id, title: `Step ${id}`, owner: "sub", status: "waiting", after: [], todo_ids: [], sub: `lane-${id}`, sub_id: `sid-${id}`, ...over,
});
const runOf = (steps: Over[], over: Over = {}) => ({
  session_id: "main",
  run: { id: "run-1", title: "Finish todos", goal: "ship the release", status: "open", steps, ...over },
});

/** Three chains of two lanes, a review gate after all three, then the chat's own release. */
const THREE_CHAINS = [
  step("s1", { status: "done", title: "Footer" }), step("s2", { after: ["s1"], status: "running", title: "Footer tests" }),
  step("s3", { status: "done", title: "Header" }), step("s4", { after: ["s3"], title: "Header tests" }),
  step("s5", { status: "blocked", title: "Pricing", note: "needs a decision" }), step("s6", { after: ["s5"], title: "Pricing tests" }),
  step("s7", { after: ["s2", "s4", "s6"], title: "Review gate" }),
  step("s8", { owner: "main", after: ["s7"], title: "Release", sub: undefined, sub_id: undefined }),
];

async function openMain(page: Page, run: unknown, settings: Over = {}): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mountView(page, {
    view: "sessions",
    chatView: "dashboard",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      get_settings: { theme: "void", chatView: "dashboard", ...settings },
      list_instances: [MAIN],
      get_active_sessions: [MAIN],
      list_subchats_on: ["main"],
      load_history_page: { events: HISTORY, oldest_seq: 0, newest_seq: HISTORY.length, has_more: false },
      context_status: { model: "claude-opus-5", window: 1_000_000, occupancy: 100_000, remaining: 900_000, pct_used: 10, pct_left: 90 },
      list_subchat_cards: [], list_previews: [], send_message: null,
      run_plan_state: run,
    },
  });
  await page.locator(`#sessions-list li[data-session-id="main"]`).click();
  await page.locator("#session-pane .cdash").waitFor();
  await page.waitForFunction(() => {
    const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
    return (w.__ccListeners?.get("run-plan-changed")?.size ?? 0) > 0;
  });
}

/** The daemon's next answer to `run_plan_state`, then its announcement. */
async function change(page: Page, run: unknown): Promise<void> {
  await page.evaluate((next) => {
    const tauri = (window as unknown as { __TAURI__: { core: { invoke: (c: string, a?: unknown) => Promise<unknown> } } }).__TAURI__;
    const orig = tauri.core.invoke;
    tauri.core.invoke = (cmd, args) => (cmd === "run_plan_state" ? Promise.resolve(next) : orig(cmd, args));
  }, run);
  await fireEvent(page, "run-plan-changed", [{ session_id: "main", run_id: "run-1", status: "open" }]);
}

const plan = (page: Page) => page.locator("#session-pane .cdash-right .cdash-plan");
/** The run section: the one part of the Plan card that is the run's. */
const card = (page: Page) => plan(page).locator(".rn-host");
const pill = (page: Page, title: string) => card(page).locator(".rn-pill", { hasText: title });

test.describe("chat dashboard / Plan card run section", () => {
  test("a chat with no run has no run section, and the Plan card is just the plan", async ({ page }) => {
    await openMain(page, { session_id: "main", run: null });
    await expect(plan(page)).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    await capture(plan(page), "plan-run-merged-without-run");
  });

  test("one Plan card: the run sits inside it under the plan, with no card or header of its own", async ({ page }) => {
    await openMain(page, runOf(THREE_CHAINS));
    await expect(card(page)).toBeVisible();
    await expect(page.locator("#session-pane .cdash-run")).toHaveCount(0);
    await expect(page.locator("#session-pane .cdash-right .cdash-card").filter({ has: page.locator(".rn-host") })).toHaveCount(1);
    await expect(plan(page).locator(".cdash-h")).toHaveCount(1);
    await expect(plan(page).locator(".cdash-h-t")).toHaveText("Plan");
    const body = await plan(page).locator(".cdash-pbody").boundingBox();
    const run = await card(page).boundingBox();
    expect(run!.y).toBeGreaterThanOrEqual(body!.y + body!.height);
    expect(await card(page).evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("1px");
  });

  test("a tick of the plan above redraws the card but not the run section", async ({ page }) => {
    await openMain(page, runOf(THREE_CHAINS));
    const lane = pill(page, "Footer tests");
    await lane.evaluate((el) => { (el as HTMLElement).dataset["probe"] = "kept"; });
    await card(page).locator(".rn-end-l").click();
    await expect(card(page).locator(".rn-end-l")).toHaveAttribute("aria-expanded", "true");
    const steps = plan(page).locator(".cdash-step");
    await expect(steps.first()).toHaveClass(/cdash-step--active/);
    await fireEvent(page, "chat:main", planEvents(1, "p1"));
    await expect(steps.first()).toHaveClass(/cdash-step--done/);
    await expect(lane).toHaveAttribute("data-probe", "kept");
    await expect(card(page).locator(".rn-end-l")).toHaveAttribute("aria-expanded", "true");
    await expect(card(page).locator(".rn-chain.is-new, .rn-lane.is-new")).toHaveCount(0);
    await capture(plan(page), "plan-run-merged-with-run");
  });

  test("a run the chat gave up draws nothing", async ({ page }) => {
    await openMain(page, runOf([step("s1")], { status: "stopped" }));
    await expect(card(page)).toHaveCount(0);
  });

  test("shows each chain as a row of lanes, the steps after them and what wakes the chat", async ({ page }) => {
    await openMain(page, runOf(THREE_CHAINS));
    await expect(card(page)).toBeVisible();
    await expect(card(page).locator(".rn-name")).toHaveText("Finish todos");
    await expect(card(page).locator(".rn-count")).toHaveText("2 of 8");
    await expect(card(page).locator(".rn-chip")).toHaveText("Blocked");
    await expect(card(page).locator(".rn-chain")).toHaveCount(3);
    await expect(card(page).locator(".rn-chain").first().locator(".rn-pill")).toHaveText([/Footer/, /Footer tests/]);
    await expect(card(page).locator(".rn-end .rn-pill")).toHaveText([/Review gate/, /Release/]);
    await expect(card(page).locator(".rn-end .rn-who")).toHaveText("you");
    // A blocked lane says so by its colour and icon and its tooltip; the card draws no sentence about it.
    await expect(card(page).locator(".rn-wakes")).toHaveCount(0);
    await expect(card(page).locator('[aria-label="Pricing, blocked"]')).toHaveAttribute("title", /needs a decision/);
    // Only a lane with a chat is a button; the chat's own step is plain text.
    await expect(card(page).locator('[aria-label="Footer, done"]')).toHaveJSProperty("tagName", "BUTTON");
    await expect(pill(page, "Release")).toHaveJSProperty("tagName", "SPAN");
    await capture(page.locator("#session-pane"), "pc-1804-run-card-open");
  });

  test("a lane turning done patches in place: same elements, no enter animation, new count", async ({ page }) => {
    await openMain(page, runOf(THREE_CHAINS));
    const lane = pill(page, "Footer tests");
    await lane.evaluate((el) => { (el as HTMLElement).dataset["probe"] = "kept"; });
    const done = THREE_CHAINS.map((s) => (s["id"] === "s2" ? { ...s, status: "done" } : s));
    await change(page, runOf(done));
    await expect(card(page).locator(".rn-count")).toHaveText("3 of 8");
    await expect(lane).toHaveAttribute("data-probe", "kept");
    await expect(lane.locator(".rn-ic")).toHaveClass(/ph-check-circle/);
    await expect(card(page).locator(".rn-chain.is-new, .rn-lane.is-new")).toHaveCount(0);
  });

  test("a new chain folds in and a chain that went folds away", async ({ page }) => {
    await openMain(page, runOf([step("s1", { title: "Footer" })]));
    await expect(card(page).locator(".rn-chain")).toHaveCount(1);
    await change(page, runOf([step("s1", { title: "Footer" }), step("s2", { title: "Header" })]));
    await expect(card(page).locator(".rn-chain")).toHaveCount(2);
    await change(page, runOf([step("s2", { title: "Header" })]));
    await expect(card(page).locator(".rn-chain")).toHaveCount(1);
    await expect(card(page).locator(".rn-pill")).toHaveText([/Header/]);
  });

  test("a finished run says so, wakes nobody, and its x clears it", async ({ page }) => {
    const finished = THREE_CHAINS.map((s) => ({ ...s, status: "done" }));
    await openMain(page, runOf(finished, { status: "done" }));
    await expect(card(page).locator(".rn-chip")).toHaveText("Finished");
    // Hovering draws the x without moving anything. The card's enter motion ends first.
    await page.waitForTimeout(700);
    const before = await card(page).boundingBox();
    const nameBefore = await card(page).locator(".rn-name").boundingBox();
    await card(page).hover();
    await expect(card(page).locator(".rn-x")).toBeVisible();
    expect(await card(page).boundingBox()).toEqual(before);
    expect(await card(page).locator(".rn-name").boundingBox()).toEqual(nameBefore);
    await capture(page.locator("#session-pane"), "pc-1804-run-card-finished");
    await card(page).locator(".rn-x").click();
    await expect(card(page)).toHaveCount(0);
    // Another read of the same run does not bring it back.
    await change(page, runOf(finished, { status: "done" }));
    await expect(card(page)).toHaveCount(0);
  });

  test("an open run has no x to click", async ({ page }) => {
    await openMain(page, runOf(THREE_CHAINS));
    await card(page).hover();
    await expect(card(page).locator(".rn-x")).toBeHidden();
  });

  test("a lane click opens that lane's chat, a step of the chat's own opens nothing", async ({ page }) => {
    await openMain(page, runOf(THREE_CHAINS));
    const mark = (await invokeCalls(page)).length;
    await pill(page, "Release").click();
    expect((await invokeCalls(page)).slice(mark).some((c) => JSON.stringify(c.args ?? {}).includes("sid-"))).toBe(false);
    await pill(page, "Footer tests").click();
    await expect.poll(async () => (await invokeCalls(page)).slice(mark).some((c) => JSON.stringify(c.args ?? {}).includes("sid-s2"))).toBe(true);
  });

  test("Then opens the row of lanes the steps after the chains wait for, and a name lights its lane", async ({ page }) => {
    await openMain(page, runOf(THREE_CHAINS));
    const then = card(page).locator(".rn-end-l");
    const refs = card(page).locator(".rn-ref");
    const fold = card(page).locator(".rn-after-fold");
    // Closed: the names are not shown, and the fold declares a transition so opening is not a snap.
    await expect(then).toHaveAttribute("aria-expanded", "false");
    await expect(fold).toHaveCSS("opacity", "0");
    expect(await fold.evaluate((el) => getComputedStyle(el).transitionProperty)).toContain("grid-template-rows");
    // Folded, the names are out of the tab order: Tab from "Then" lands past them.
    await expect(fold).toHaveAttribute("inert", "");
    // Folded, the row takes no height at all.
    expect((await fold.boundingBox())!.height).toBe(0);
    await then.focus();
    await page.keyboard.press("Tab");
    await expect(card(page).locator(".rn-ref:focus")).toHaveCount(0);
    await then.click();
    await expect(fold).not.toHaveAttribute("inert", "");
    await expect(then).toHaveAttribute("aria-expanded", "true");
    await expect(fold).toHaveCSS("opacity", "1");
    await expect(refs).toHaveText(["Footer tests", "Header tests", "Pricing tests"]);
    // The lane under a hovered name is lit with its row, and the row's box does not move.
    const row = card(page).locator(".rn-chain").first();
    const rowBox = await row.boundingBox();
    await refs.nth(0).hover();
    await expect(card(page).locator(".rn-lane", { hasText: "Footer tests" })).toHaveClass(/is-ref/);
    await expect(row).toHaveClass(/is-ref/);
    await expect(card(page).locator(".rn-lane.is-ref")).toHaveCount(1);
    expect(await row.boundingBox()).toEqual(rowBox);
    await card(page).locator(".rn-name").hover();
    await expect(card(page).locator(".is-ref")).toHaveCount(0);
    // Keyboard focus does the same as the pointer.
    await refs.nth(2).focus();
    await expect(card(page).locator(".rn-lane", { hasText: "Pricing tests" })).toHaveClass(/is-ref/);
    await refs.nth(2).blur();
    await expect(card(page).locator(".is-ref")).toHaveCount(0);
    // Closing again leaves nothing lit and the names out of sight.
    await refs.nth(1).hover();
    await then.click();
    await expect(then).toHaveAttribute("aria-expanded", "false");
    await expect(card(page).locator(".is-ref")).toHaveCount(0);
    await expect(fold).toHaveCSS("opacity", "0");
  });

  test("a Then that waits on no lane is a plain label with nothing to open", async ({ page }) => {
    await openMain(page, runOf([
      step("s1", { status: "running", title: "Footer" }),
      step("s2", { owner: "main", title: "Own first step", sub: undefined, sub_id: undefined }),
    ]));
    const then = card(page).locator(".rn-end-l");
    await expect(then).toBeDisabled();
    await expect(then.locator(".ph")).toBeHidden();
    await expect(card(page).locator(".rn-ref")).toHaveCount(0);
  });

  test("a lane ticking over keeps the open row and its names", async ({ page }) => {
    await openMain(page, runOf(THREE_CHAINS));
    await card(page).locator(".rn-end-l").click();
    const first = card(page).locator(".rn-ref").first();
    await first.evaluate((el) => { (el as HTMLElement).dataset["probe"] = "kept"; });
    await change(page, runOf(THREE_CHAINS.map((s) => (s["id"] === "s2" ? { ...s, status: "done" } : s))));
    await expect(card(page).locator(".rn-count")).toHaveText("3 of 8");
    await expect(first).toHaveAttribute("data-probe", "kept");
    await expect(card(page).locator(".rn-end-l")).toHaveAttribute("aria-expanded", "true");
  });

  test("the card uses the type scale of the Done and Subchats cards and has no uppercase labels", async ({ page }) => {
    await openMain(page, runOf(THREE_CHAINS));
    const size = (sel: string) => card(page).locator(sel).first().evaluate((el) => getComputedStyle(el).fontSize);
    expect(await size(".rn-name")).toBe("13px");
    expect(await size(".rn-pill")).toBe("12.5px");
    expect(await size(".rn-chip")).toBe("11.5px");
    expect(await size(".rn-count")).toBe("11.5px");
    expect(await size(".rn-end-l")).toBe("11.5px");
    for (const sel of [".rn-chip", ".rn-who", ".rn-end-l"]) {
      expect(await card(page).locator(sel).first().evaluate((el) => getComputedStyle(el).textTransform)).toBe("none");
    }
  });

  test("a change announced for another chat is ignored", async ({ page }) => {
    await openMain(page, runOf(THREE_CHAINS));
    const reads = () => invokeCalls(page).then((c) => c.filter((x) => x.cmd === "run_plan_state").length);
    const before = await reads();
    await fireEvent(page, "run-plan-changed", [{ session_id: "someone-else", run_id: "x", status: "open" }]);
    await page.waitForTimeout(400);
    expect(await reads()).toBe(before);
    await fireEvent(page, "run-plan-changed", [{ session_id: "main", run_id: "run-1", status: "open" }]);
    await expect.poll(reads).toBe(before + 1);
  });

  test("a cleared finished run comes back when the chat reopens the same run", async ({ page }) => {
    const finished = THREE_CHAINS.map((s) => ({ ...s, status: "done" }));
    await openMain(page, runOf(finished, { status: "done" }));
    await card(page).hover();
    await card(page).locator(".rn-x").click();
    await expect(card(page)).toHaveCount(0);
    // `run_plan add` keeps the run id and the run is open again.
    const reopened = [...finished, step("s9", { title: "Hotfix", status: "running" })];
    await change(page, runOf(reopened, { status: "open" }));
    await expect(card(page)).toBeVisible();
    await expect(card(page).locator(".rn-chip")).toHaveText("Running");
    // It finishes a second time: the earlier clearing does not hide this ending.
    await change(page, runOf(reopened.map((s) => ({ ...s, status: "done" })), { status: "done" }));
    await expect(card(page).locator(".rn-chip")).toHaveText("Finished");
  });

  test("a run that grew and finished again shows even when the open read was never seen", async ({ page }) => {
    const finished = THREE_CHAINS.map((s) => ({ ...s, status: "done" }));
    await openMain(page, runOf(finished, { status: "done" }));
    await card(page).hover();
    await card(page).locator(".rn-x").click();
    await expect(card(page)).toHaveCount(0);
    await change(page, runOf([...finished, step("s9", { title: "Hotfix", status: "done" })], { status: "done" }));
    await expect(card(page).locator(".rn-chip")).toHaveText("Finished");
    await expect(pill(page, "Hotfix")).toBeVisible();
  });

  test("a fork's second branch has no arrow from its sibling", async ({ page }) => {
    await openMain(page, runOf([step("a", { title: "Base" }), step("b", { after: ["a"], title: "Left" }), step("c", { after: ["a"], title: "Right" })]));
    const lanes = card(page).locator(".rn-chain .rn-lane");
    await expect(lanes).toHaveCount(3);
    await expect(lanes.nth(1).locator(".rn-arrow")).toBeVisible();
    await expect(lanes.nth(2).locator(".rn-arrow")).toBeHidden();
  });
});
