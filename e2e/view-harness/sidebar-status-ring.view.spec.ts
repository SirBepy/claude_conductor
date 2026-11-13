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
  await expect.poll(() => page.locator(".sessions-list .row-entering").count()).toBe(0);
}

const row = (page: Page, id: string) => page.locator(`#sessions-list li[data-session-id="${id}"]`);

test.describe("view-harness / sidebar status ring", () => {
  test("a working chat with a plan draws a 2-of-4 arc over a dim track, in the working colour", async ({ page }) => {
    await mountSessions(page);
    const circles = row(page, "s-plan").locator(".avatar-ring circle");
    // Track, done arc, and the glowing step in progress.
    await expect(circles).toHaveCount(3);
    await expect(circles.nth(0)).toHaveClass(/is-track/);
    await expect(circles.nth(1)).toHaveAttribute("data-tone", "working");
    await expect(circles.nth(2)).toHaveClass(/is-glow/);

    // Measured, not eyeballed: the arc is half the circumference.
    const [full, arc] = await circles.evaluateAll((els) =>
      els.map((el) => {
        const [drawn = 0, gap = 0] = getComputedStyle(el).strokeDasharray.split(/[ ,]+/).map(parseFloat);
        return drawn / (drawn + gap);
      }),
    );
    expect(full).toBeCloseTo(1, 2);
    expect(arc).toBeCloseTo(0.5, 2);
  });

  test("working with no plan is one solid, glowing ring and nothing rotates", async ({ page }) => {
    await mountSessions(page);
    const ring = row(page, "s-noplan").locator(".avatar-ring");
    await expect(ring.locator("circle")).toHaveCount(1);
    await expect(ring.locator("circle")).toHaveClass(/is-glow/);
    // Joe, 2026-11-03: a rotating arc was too loud.
    expect(await ring.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  });

  test("a waiting question with no parked prompt falls back to one pulsing ring", async ({ page }) => {
    await mountSessions(page);
    const circles = row(page, "s-q").locator(".avatar-ring circle");
    await expect(circles).toHaveCount(1);
    await expect(circles).toHaveClass(/is-pulse/);
    await expect(circles).toHaveAttribute("data-tone", "question");
  });

  test("a finished, already-read chat has no ring, and no row keeps the old dot", async ({ page }) => {
    await mountSessions(page);
    await expect(row(page, "s-done").locator(".avatar-ring")).toHaveCount(0);
    await expect(page.locator("#sessions-list .avatar-status-dot")).toHaveCount(0);
  });

  test("the ring sits under the project badge and does not move the row's layout", async ({ page }) => {
    await mountSessions(page);
    const r = row(page, "s-plan");
    const geometry = await r.evaluate((li) => {
      const ring = li.querySelector(".avatar-ring")!.getBoundingClientRect();
      const art = li.querySelector(".session-avatar")!.getBoundingClientRect();
      const badge = li.querySelector(".session-proj-badge");
      return {
        ringW: ring.width, artW: art.width, ringLeft: ring.left, artLeft: art.left,
        ringZ: Number(getComputedStyle(li.querySelector(".avatar-ring")!).zIndex),
        badgeZ: badge ? Number(getComputedStyle(badge).zIndex) : 0,
        rowH: li.getBoundingClientRect().height,
      };
    });
    expect(geometry.ringW).toBeCloseTo(geometry.artW, 0);
    expect(geometry.ringLeft).toBeCloseTo(geometry.artLeft, 0);
    expect(geometry.ringZ).toBeLessThan(geometry.badgeZ);
    expect(geometry.rowH).toBe(52);
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

  test("hovering the title opens the card and no second small tooltip", async ({ page }) => {
    await mountSessions(page);
    await row(page, "s-plan").locator(".session-row-title-text").hover();
    await expect(page.locator(".cc-row-card")).toBeVisible();
    await expect(page.locator(".cc-row-tip:visible")).toHaveCount(0);
  });

  test("hovering the model battery keeps its small tip and does not also open the card", async ({ page }) => {
    await mountSessions(page);
    await row(page, "s-plan").locator(".session-model-battery").hover();
    await page.waitForTimeout(600);
    await expect(page.locator(".cc-row-card")).toBeHidden();
  });

  test("the phone gets no hover card and no row tooltip", async ({ page }) => {
    await mountViewPhone(page, { view: "sessions", invoke: INVOKE });
    await page.locator("#sessions-list li[data-session-id]").first().waitFor();
    const r = row(page, "s-plan");
    const box = (await r.boundingBox())!;
    await page.mouse.move(box.x + 6, box.y + box.height / 2);
    await page.waitForTimeout(600);
    await expect(page.locator(".cc-row-card")).toHaveCount(0);
    await r.locator(".session-row-title-text").hover();
    await page.waitForTimeout(300);
    await expect(page.locator(".cc-row-tip:visible")).toHaveCount(0);
  });
});
