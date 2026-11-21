import { test, expect, type Page } from "@playwright/test";
import { capture, fireEvent, invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance, userMsg } from "./harness";

// asserts: src/views/sessions/chat-dashboard/run-card.ts, src/views/sessions/chat-dashboard/run-card.css, src/views/sessions/chat-dashboard/run-source.ts, src/shared/chat/dashboard/run-model.ts

// The dashboard's Run card (pc-1804 step 5): the plan a main chat holds with `run_plan`, as one
// row per chain of lanes, the steps after them, and what wakes the chat. It is patched in place
// when the daemon announces a change, and a finished run can be cleared with a hover x.

const CWD = "C:/Projects/cv-site";
const MAIN = sessionInstance({ session_id: "main", name: "Finish todos", pid: 101, cwd: CWD });
const HISTORY = [userMsg("work through the todo list")];

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

const card = (page: Page) => page.locator("#session-pane .cdash-right .cdash-run");
const pill = (page: Page, title: string) => card(page).locator(".rn-pill", { hasText: title });

test.describe("chat dashboard / Run card", () => {
  test("a chat with no run has no card", async ({ page }) => {
    await openMain(page, { session_id: "main", run: null });
    await expect(card(page)).toHaveCount(0);
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
    // A blocked lane outranks everything: the line names it and says the chat was woken.
    await expect(card(page).locator(".rn-wakes")).toContainText("Blocked: Pricing");
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
    await expect(card(page).locator(".rn-wakes")).toContainText("Nothing more wakes this chat");
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
  });

  test("a fork's second branch has no arrow from its sibling", async ({ page }) => {
    await openMain(page, runOf([step("a", { title: "Base" }), step("b", { after: ["a"], title: "Left" }), step("c", { after: ["a"], title: "Right" })]));
    const lanes = card(page).locator(".rn-chain .rn-lane");
    await expect(lanes).toHaveCount(3);
    await expect(lanes.nth(1).locator(".rn-arrow")).toBeVisible();
    await expect(lanes.nth(2).locator(".rn-arrow")).toBeHidden();
  });

  test("Settings can switch the card off", async ({ page }) => {
    await openMain(page, runOf(THREE_CHAINS), { dashboardSections: { run: false } });
    await expect(card(page)).toHaveCount(0);
  });
});
