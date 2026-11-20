// Reviewed 2026-11-16 (chat heads, pc-1769): rows are 44px heads; an idle read chat draws the faint ring (tone idle); the title and battery hovers are the face and battery hovers.
// asserts: src/views/sessions/chat-heads.ts, src/views/sessions/sidebar-ring.ts, src/views/sessions/sidebar-hover-card.ts
import { test, expect, type Page } from "@playwright/test";
import { SESSIONS_BASE_INVOKE, sessionInstance, mountView, mountViewPhone, capture } from "./harness";

// The status ring replaced the bottom-left dot: shape says how
// far, colour says which state. This drives the REAL sidebar, so it fails if
// the row template, the ring markup or its CSS stop agreeing.

const CHARACTER_INVOKE = {
  list_session_characters: { "s-plan": "a", "s-noplan": "b", "s-q": "c", "s-done": "d" },
  character_asset_url:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAoMBgDTD2qgAAAAASUVORK5CYII=",
};

const MIN = 60_000;
const since = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function instance(over: Parameters<typeof sessionInstance>[0] = {}) {
  return sessionInstance({ cwd: "C:/Projects/claude_usage_in_taskbar", ...over });
}

const PLAN = [
  { text: "Read the code", status: "done" },
  { text: "Write the driver", status: "done" },
  { text: "Render the rows", status: "active" },
  { text: "Verify the shot", status: "pending" },
];

const SESSIONS = [
  instance({
    session_id: "s-plan", name: "Wiring the driver", busy: true, awaiting: null,
    progress: { plan: PLAN, state_since: since(4 * MIN) },
  }),
  instance({ session_id: "s-noplan", name: "No plan chat", busy: true, awaiting: null, pid: 101 }),
  instance({
    session_id: "s-q", name: "Waiting on you", awaiting: "question", pid: 102,
    progress: { plan: null, state_since: since(12 * MIN) },
  }),
  instance({ session_id: "s-done", name: "All finished", awaiting: "done", pid: 103 }),
];

const INVOKE = {
  ...SESSIONS_BASE_INVOKE, ...CHARACTER_INVOKE,
  list_instances: SESSIONS, get_active_sessions: SESSIONS,
  context_status: { model: "claude-opus-5", window: 1_000_000, occupancy: 340_000, remaining: 660_000, pct_used: 34, pct_left: 66 },
};

async function mountSessions(page: Page): Promise<void> {
  await mountView(page, { view: "sessions", invoke: INVOKE });
  await page.locator("#sessions-list li[data-session-id]").first().waitFor();
}

const row = (page: Page, id: string) => page.locator(`#sessions-list li[data-session-id="${id}"]`);

test.describe("view-harness / sidebar status ring", () => {
  test("no head draws a status ring: not for a plan, a plain working chat, a question or a read chat", async ({ page }) => {
    await mountSessions(page);
    await expect(page.locator("#sessions-list .avatar-ring")).toHaveCount(0);
    // The state stays on the li for the hover card and the menus; the one red number is what a circle says.
    await expect(row(page, "s-plan")).toHaveAttribute("data-st", "st-working");
    await expect(row(page, "s-q").locator(".chat-head-tag .ht-n.is-red")).toHaveText("1");
    for (const id of ["s-plan", "s-noplan", "s-done"]) await expect(row(page, id).locator(".ht-n")).toHaveCount(0);
    await expect(page.locator("#sessions-list .avatar-status-dot")).toHaveCount(0);
  });

  test("the head's layout is the 44px circle and its corner badge sits above the project badge", async ({ page }) => {
    await mountSessions(page);
    const geometry = await row(page, "s-q").evaluate((li) => {
      const art = li.querySelector(".chat-head-face")!.getBoundingClientRect();
      const n = li.querySelector(".chat-head-tag .ht-n")!;
      const badge = li.querySelector(".chat-head-badge");
      return {
        artW: art.width,
        nZ: Number(getComputedStyle(li.querySelector(".chat-head-tag")!).zIndex),
        badgeZ: badge ? Number(getComputedStyle(badge).zIndex) : 0,
        nPos: getComputedStyle(n.parentElement!).position,
        rowH: li.getBoundingClientRect().height,
      };
    });
    expect(geometry.artW).toBeCloseTo(44, 0);
    expect(geometry.nPos).toBe("absolute");
    expect(geometry.nZ).toBeGreaterThanOrEqual(geometry.badgeZ);
    expect(geometry.rowH).toBeCloseTo(44, 0);
  });

  test("hovering a working row opens the card with its plan, the turn timer and the context %", async ({ page }) => {
    await mountSessions(page);
    // Off the [data-tip] anchors (battery, badges): the card waits for plain row space.
    const box = (await row(page, "s-plan").boundingBox())!;
    await page.mouse.move(box.x + 6, box.y + box.height / 2);

    const card = page.locator(".cc-row-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Plan: 2 of 4 steps");
    await expect(card).toContainText("Render the rows");
    await expect(card).toContainText("turn 4m");
    await expect(card.locator(".hc-ctx")).toContainText("34%");
    // The statusline's own context glyph, not a new one.
    await expect(card.locator(".hc-ctx i")).toHaveClass(/ph-stack/);
    await capture(page.locator("body"), "sidebar-hover-card-plan");

    await page.mouse.move(box.x + 6, box.y + 400);
    await expect(card).toBeHidden();
  });

  test("hovering a chat again shows its current context %, not the one from the first hover", async ({ page }) => {
    await mountSessions(page);
    const box = (await row(page, "s-plan").boundingBox())!;
    const card = page.locator(".cc-row-card");
    await page.mouse.move(box.x + 6, box.y + box.height / 2);
    await expect(card.locator(".hc-ctx")).toContainText("34%");
    await page.mouse.move(box.x + 6, box.y + 400);
    await expect(card).toBeHidden();

    // The chat kept working in the background: the daemon now reports more context used.
    await page.evaluate(() => {
      const core = (window as unknown as { __TAURI__: { core: { invoke: (c: string, a?: unknown) => Promise<unknown> } } }).__TAURI__.core;
      const orig = core.invoke;
      core.invoke = (cmd, args) => cmd === "context_status"
        ? Promise.resolve({ model: "claude-opus-5", window: 1_000_000, occupancy: 510_000, remaining: 490_000, pct_used: 51, pct_left: 49 })
        : orig(cmd, args);
    });
    await page.mouse.move(box.x + 6, box.y + box.height / 2);
    await expect(card).toBeVisible();
    await expect(card.locator(".hc-ctx")).toContainText("51%");
  });

  test("hovering the head's face opens the card and no second small tooltip", async ({ page }) => {
    await mountSessions(page);
    await row(page, "s-plan").locator(".chat-head-face").hover({ position: { x: 22, y: 22 } });
    await expect(page.locator(".cc-row-card")).toBeVisible();
    await expect(page.locator(".cc-row-tip:visible")).toHaveCount(0);
  });

  test("hovering the model battery opens the card (the head's battery has no tip of its own) and the card names the model", async ({ page }) => {
    await mountSessions(page);
    // The marks take no pointer events, so the battery's corner of the head is the head: the card, never a tip.
    await row(page, "s-plan").locator(".chat-head-face").hover({ position: { x: 40, y: 40 } });
    await expect(page.locator(".cc-row-card")).toBeVisible();
    await expect(page.locator(".cc-row-card")).toContainText("Opus");
    await expect(page.locator(".cc-row-tip:visible")).toHaveCount(0);
  });

  test("the phone gets no hover card and no row tooltip", async ({ page }) => {
    await mountViewPhone(page, { view: "sessions", invoke: INVOKE });
    await page.locator("#sessions-list li[data-session-id]").first().waitFor();
    const r = row(page, "s-plan");
    const box = (await r.boundingBox())!;
    await page.mouse.move(box.x + 6, box.y + box.height / 2);
    await page.waitForTimeout(600);
    await expect(page.locator(".cc-row-card")).toHaveCount(0);
    await r.locator(".chat-head-face").hover({ position: { x: 22, y: 22 } });
    await page.waitForTimeout(300);
    await expect(page.locator(".cc-row-tip:visible")).toHaveCount(0);
  });
});
