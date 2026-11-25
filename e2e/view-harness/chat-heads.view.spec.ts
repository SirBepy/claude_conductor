// Reviewed 2026-11-24: heads lost their bottom-right model battery (model and effort are words on the hover card); the corner test asserts its absence and the number's corner.
// Reviewed 2026-11-21 (put away, pc-1806 step 5): a project's main chat that the daemon put away (hidden_at) joins the Hidden view with a Paused badge, opens read-only, and its Close reads Put away; nothing this spec asserts changed (its chats carry no hidden_at), and it passes in the run of every spec that depends on those files.
// Reviewed 2026-11-21 (the open chat's viewed mark is renewed every minute by a heartbeat in chat-seen.ts, started from sidebar.ts): nothing this spec asserts changed, and it passes in the run of every spec that depends on sidebar.ts.
// asserts: src/views/sessions/chat-heads.ts, src/views/sessions/chat-heads.css, src/views/sessions/sidebar.ts, src/views/sessions/sidebar-ring.ts, src/views/sessions/template.ts, src/shared/projects.ts
import { test, expect, type Locator, type Page } from "@playwright/test";
import { capture, invokeCalls, mountView, mountViewPhone, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// The chat heads (docs/chat-heads-design.md) replaced the 260px chat list: a stack of round heads
// floating over the chat pane's top-left corner. This drives the REAL view, so it fails if the
// head markup, its CSS or the toggle stop agreeing.

const DESKTOP = { width: 1280, height: 800 };
const MIN = 60_000;
const since = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

type Over = Parameters<typeof sessionInstance>[0];
const chat = (id: string, name: string, pid: number, over: Over = {}) =>
  sessionInstance({ session_id: id, name, pid, cwd: "C:/Projects/claude_usage_in_taskbar", started_at: since((20 - pid % 100) * MIN), ...over });

const PLAN = [
  { text: "Read the code", status: "done" },
  { text: "Write the driver", status: "done" },
  { text: "Render the rows", status: "active" },
  { text: "Verify the shot", status: "pending" },
] as const;

const CHAR_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAoMBgDTD2qgAAAAASUVORK5CYII=";

const SESSIONS = [
  chat("s-plan", "Wiring the driver", 101, { busy: true, awaiting: null, progress: { plan: [...PLAN] as never, state_since: since(4 * MIN) }, model: "claude-opus-5", effort: "high" }),
  chat("s-q", "Waiting on you", 102, { awaiting: "question", progress: { plan: null, state_since: since(12 * MIN) } }),
  chat("s-done", "All finished", 103, { awaiting: "done" }),
  chat("s-ext", "Started in a terminal", 104, { kind: "external" }),
  chat("s-wait", "Waits on a process", 105, { awaiting: "waiting", model: "claude-sonnet-5" }),
  chat("s-hidden", "Parked away", 106),
  chat("main", "Main of the project", 107, { cwd: "C:/Projects/rodge", project_id: "p-rodge" }),
  chat("sub-1", "Footer", 108, { cwd: "C:/Projects/rodge", project_id: "p-rodge", subchat_of: "main", busy: true, awaiting: "question" }),
];

const INVOKE = {
  ...SESSIONS_BASE_INVOKE,
  list_instances: SESSIONS, get_active_sessions: SESSIONS,
  list_session_characters: { "s-plan": "a", "s-q": "b", "s-done": "c", "s-ext": "d", "s-wait": "e", "s-hidden": "f" },
  character_asset_url: CHAR_URL,
  list_subchats_on: ["main"],
  get_project_icon: null,
  get_project_tech: null,
  context_status: { model: "claude-opus-5", window: 1_000_000, occupancy: 340_000, remaining: 660_000, pct_used: 34, pct_left: 66 },
};

async function mount(page: Page, hidden: string[] = ["s-hidden"]): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await page.addInitScript((ids) => { localStorage.setItem("cc_hidden_sessions", JSON.stringify(ids)); }, hidden);
  await mountView(page, { view: "sessions", invoke: INVOKE });
  await page.locator("#sessions-list li.chat-head[data-session-id]").first().waitFor();
}

const head = (page: Page, id: string): Locator => page.locator(`#sessions-list li[data-session-id="${id}"]`);
const toggle = (page: Page): Locator => page.locator("#sessions-list li[data-heads-toggle]");

test.describe("view-harness / chat heads", () => {
  test("the stack replaces the sidebar: no 260px list, no group headers", async ({ page }) => {
    await mount(page);
    await expect(page.locator(".sessions-sidebar")).toHaveCount(0);
    await expect(page.locator(".session-group-header")).toHaveCount(0);
    const box = await page.locator("#chat-heads").boundingBox();
    expect(box!.x).toBeLessThan(20);
    await capture(page, "chat-heads-desktop-stack");
  });

  test("every head is a 44px circle with no title text", async ({ page }) => {
    await mount(page);
    const box = await head(page, "s-plan").boundingBox();
    expect(Math.round(box!.width)).toBe(44);
    expect(Math.round(box!.height)).toBe(44);
    await expect(head(page, "s-plan")).not.toContainText("Wiring the driver");
  });

  test("a head draws no status ring: a chat that asks wears one red number instead, and the state stays on the li", async ({ page }) => {
    await mount(page);
    await expect(page.locator("#sessions-list .avatar-ring")).toHaveCount(0);
    await expect(head(page, "s-q").locator(".chat-head-tag .ht-n.is-red")).toHaveText("1");
    for (const id of ["s-plan", "s-done", "s-ext", "s-wait"]) await expect(head(page, id).locator(".ht-n")).toHaveCount(0);
    await expect(head(page, "s-q")).toHaveAttribute("data-st", /attention|question/);
  });

  test("a head draws no battery, and the one number sits top-right of the face", async ({ page }) => {
    await mount(page);
    const m = await head(page, "s-q").evaluate((li) => {
      const mid = (sel: string) => { const r = li.querySelector(sel)!.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
      return { face: mid(".chat-head-face"), count: mid(".chat-head-tag .ht-n") };
    });
    await expect(head(page, "s-q").locator(".chat-head-battery, .session-model-battery")).toHaveCount(0);
    expect(m.count.x).toBeGreaterThan(m.face.x);
    expect(m.count.y).toBeLessThan(m.face.y);
  });

  test("the toggle head closes the stack, carries the red count while closed, and reopens it", async ({ page }) => {
    await mount(page);
    await toggle(page).click();
    await expect(head(page, "s-plan")).toHaveCount(0);
    await expect(toggle(page).locator(".chat-head-count")).toHaveCount(1);
    await capture(page, "chat-heads-toggle-closed");
    await toggle(page).click();
    await expect(head(page, "s-plan")).toBeVisible();
    await expect(toggle(page).locator(".chat-head-count")).toHaveCount(0);
  });

  test("the + head ends the stack and is the only head with no chat behind it", async ({ page }) => {
    await mount(page);
    const plus = page.locator("#sessionsFab");
    await expect(plus).toBeVisible();
    await expect(plus).not.toHaveAttribute("data-session-id", /.+/);
    const lastId = await page.locator("#sessions-list > li").last().getAttribute("id");
    expect(lastId).toBe("sessionsFab");
  });

  test("hovering a main head lists its sub count in the card", async ({ page }) => {
    await mount(page);
    await expect(head(page, "main")).toHaveAttribute("data-facts", /1 sub/);
    const box = (await head(page, "main").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator(".cc-row-card")).toContainText("1 sub");
    await capture(page, "chat-heads-hover-card");
  });

  test("right-click opens the head menu and it has no Freeze item", async ({ page }) => {
    await mount(page);
    await head(page, "s-plan").click({ button: "right" });
    const menu = page.locator(".session-ctx-menu");
    await expect(menu).toBeVisible();
    await expect(menu).not.toContainText(/freeze/i);
    await capture(page, "chat-heads-menu");
  });

  test("holding Ctrl numbers the heads, Ctrl+Down highlights, releasing opens it", async ({ page }) => {
    await mount(page);
    await page.keyboard.down("Control");
    await expect(page.locator("#sessions-list")).toHaveClass(/kbd-hint-active/, { timeout: 5000 });
    await expect(page.locator("#sessions-list li[data-kbd-hint='1']")).toHaveCount(1);
    await capture(page, "chat-heads-ctrl-numbers");
    await page.keyboard.press("ArrowDown");
    const lit = page.locator("#sessions-list li.is-highlight");
    await expect(lit).toHaveCount(1);
    const id = await lit.getAttribute("data-session-id");
    await capture(page, "chat-heads-ctrl-highlight");
    await page.keyboard.up("Control");
    await expect(page.locator(`#sessions-list li.active[data-session-id="${id}"]`)).toHaveCount(1);
    await expect(page.locator("#sessions-list li.is-highlight")).toHaveCount(0);
  });

  test("Esc while Ctrl is held cancels: releasing opens nothing", async ({ page }) => {
    await mount(page);
    await page.keyboard.down("Control");
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("#sessions-list li.is-highlight")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await page.keyboard.up("Control");
    await expect(page.locator("#sessions-list li.is-highlight")).toHaveCount(0);
    await expect(page.locator("#sessions-list li.active")).toHaveCount(0);
  });

  test("dragging a head stores the order under chatHeadsOrder and does not open the chat", async ({ page }) => {
    await mount(page);
    // The stack animates in and settles into age order; a drag started on a moving head misses it.
    const settled = async (id: string) => { let prev = ""; await expect.poll(async () => { const b = JSON.stringify(await head(page, id).boundingBox()); const same = b === prev; prev = b; return same; }, { intervals: [120] }).toBe(true); };
    await settled("s-q"); await settled("s-plan");
    const from = (await head(page, "s-q").boundingBox())!;
    const to = (await head(page, "s-plan").boundingBox())!;
    await page.mouse.move(from.x + 22, from.y + 22);
    await page.mouse.down();
    await page.mouse.move(from.x + 22, (from.y + to.y) / 2, { steps: 5 });
    await page.mouse.move(to.x + 22, to.y + 4, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () =>
      (await invokeCalls(page)).some((c) => c.cmd === "save_settings" && JSON.stringify(c.args).includes("chatHeadsOrder"))).toBe(true);
    await expect(page.locator("#sessions-list li.active")).toHaveCount(0);
  });
});

test.describe("view-harness / chat heads on the phone", () => {
  test("the same heads sit in the same corner and a tap opens the chat and puts the stack away", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await mountViewPhone(page, { view: "sessions", invoke: INVOKE });
    await page.locator("#sessions-list li.chat-head[data-session-id]").first().waitFor();
    const box = (await head(page, "s-q").boundingBox())!;
    expect(Math.round(box.width)).toBe(44);
    expect(box.x).toBeLessThan(20);
    await capture(page, "chat-heads-phone-stack");

    await head(page, "s-q").click();
    await expect(head(page, "s-plan")).toHaveCount(0);
    await expect(toggle(page)).toBeVisible();
    await capture(page, "chat-heads-phone-stack-away");

    await toggle(page).click();
    await expect(head(page, "s-plan")).toBeVisible();
  });
});
