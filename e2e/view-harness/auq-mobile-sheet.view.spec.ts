import { test, expect, type Page } from "@playwright/test";
import { mountView } from "./harness";

// Mobile bottom-sheet redesign (Joe's ask, 2026-08-14): full-bleed, taller,
// guaranteed nav-bar clearance, drag-down-to-peek. Mounts a REAL sessions
// view (not a bare .session-composer stub) so header/composer geometry comes
// from the actual cascade - this is also what proves --composer mode (task 5).

const PHONE = { width: 393, height: 852 };

const BASE_INVOKE = {
  get_accounts_setup_prompt_state: { shouldShow: false },
  get_usage_map: {},
  get_skill_usage_week: { entries: [], total_sessions: 0 },
  poll_now: null,
  list_projects: [],
  resolve_whitelist_characters: [],
  probe_models_availability: [],
  list_accounts: [],
  list_scheduled_messages: [],
  list_session_characters: {},
  watch_session_transcript: null,
  unwatch_session_transcript: null,
  session_live_cwd: null,
  get_git_info: null,
  get_session_counts: null,
  get_context_status: null,
  get_session_drain: null,
  list_pending_prompts: [],
  get_chat_config: null,
};

const SESSION = {
  session_id: "s1", pid: 100, cwd: "C:/Projects/alpha",
  project_id: "p1", kind: "interactive", is_remote: false,
  started_at: "2026-08-01T10:00:00Z", transcript_path: null, bridge_session_id: null,
  name: "Alpha chat", ended_at: null, end_reason: null,
  busy: false, model: "claude-opus-5", effort: "high", awaiting: "done",
  autopilot: false, jarvis: false, worker_of: null, closing: false,
  account_id: null, rate_limited_resets_at: null, rate_limited_type: null,
};

async function mountPhoneSession(page: Page): Promise<void> {
  await page.setViewportSize(PHONE);
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...BASE_INVOKE,
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().waitFor();
  await page.locator("#sessions-list li[data-session-id='s1']").click();
  await page.locator("#session-pane .session-composer").waitFor();
}

async function overrideSafeArea(page: Page, bottom: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", {
    insets: { bottom, bottomMax: bottom },
  } as never);
}

const SHORT_QUESTIONS = [{ question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] }];

const MANY_OPTIONS = Array.from({ length: 14 }, (_, i) => ({
  label: `Option ${i + 1} with a longer label to pad it out`,
  description: "A fairly long description line to pad this option's rendered height out.",
}));
const TALL_QUESTIONS = [
  { question: "Which approach, given all the constraints in play here?", header: "Approach", options: MANY_OPTIONS },
];

async function openQuestionCard(page: Page, questions: unknown): Promise<void> {
  await page.evaluate(async (q) => {
    const qm = await import("/views/sessions/permission-modal/index.ts");
    qm.handleQuestionRequested({ id: "q-1", session_id: "s1", questions: q as never });
  }, questions);
  await page.locator(".prompt-card").waitFor();
}

test.describe("view-harness / mobile bottom-sheet card", () => {
  test("phone actually mounts the card in --composer mode (task 5)", async ({ page }) => {
    await mountPhoneSession(page);
    await openQuestionCard(page, SHORT_QUESTIONS);
    await expect(page.locator("#prompt-card-host")).toHaveClass(/prompt-card-host--composer/);
  });

  // The footer's own padding-box is flush with the viewport bottom by design
  // (padding fills the inset) - the button inside it must clear, not the box.
  test("footer buttons clear a real safe-area inset", async ({ page }) => {
    await mountPhoneSession(page);
    await overrideSafeArea(page, 100);
    await openQuestionCard(page, TALL_QUESTIONS);
    await page.waitForTimeout(200); // settle the card's entrance animation

    const btnBox = (await page.locator('.prompt-card__footer [data-act="primary"]').boundingBox())!;
    expect(btnBox.y + btnBox.height).toBeLessThanOrEqual(PHONE.height - 100);
  });

  test("footer clearance stays non-zero when the inset reports 0 (todo 633)", async ({ page }) => {
    await mountPhoneSession(page);
    await overrideSafeArea(page, 0);
    await openQuestionCard(page, TALL_QUESTIONS);
    await page.waitForTimeout(200);

    const btnBox = (await page.locator('.prompt-card__footer [data-act="primary"]').boundingBox())!;
    expect(PHONE.height - (btnBox.y + btnBox.height)).toBeGreaterThan(0);
  });

  // Supersedes the 2026-08-14 "project name never covered" call: the old
  // ~80px-tall sliver above the composer was unreadable, so the sheet now
  // goes truly fullscreen and the header unmounts with it (Joe, 2026-08-20).
  test("fullscreen: card covers the whole viewport and the header/statusbar/tab bar unmount", async ({ page }) => {
    await mountPhoneSession(page);
    await openQuestionCard(page, TALL_QUESTIONS);
    await page.waitForTimeout(200); // settle the entrance animation (translateY 6px -> 0)

    const cardBox = (await page.locator(".prompt-card").boundingBox())!;
    expect(cardBox.y).toBe(0);
    expect(cardBox.height).toBe(PHONE.height);
    await expect(page.locator(".session-header")).toBeHidden();
    await expect(page.locator(".session-statusbar")).toBeHidden();
    await expect(page.locator(".mobile-tabbar")).toBeHidden();
  });

  // Permission cards have no `.prompt-pager` and keep the pre-fullscreen,
  // anchored-above-composer behavior untouched.
  test("permission card still stays below the header - fullscreen is question-cards-only", async ({ page }) => {
    await mountPhoneSession(page);
    await page.evaluate(async () => {
      const pc = await import("/views/sessions/permission-modal/permission-card.ts");
      pc.showPermissionCard({
        id: "p-1", session_id: "s1", tool_name: "Bash",
        input: { command: "echo hi" },
      } as never);
    });
    const cardBox = (await page.locator(".prompt-card").boundingBox())!;
    const headerBox = (await page.locator(".session-header").boundingBox())!;
    expect(cardBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height);
    await expect(page.locator(".session-header .meta")).toBeVisible();
  });

  // b167f0e7 wrapped the composer in .composer-shell, whose 12px margin + 1px
  // border sit outside the sheet's anchor and reintroduced a 13px gutter here
  // (todo 700). sessions.css's mobile block zeroes both; full-bleed stands.
  test("full-bleed: card spans the full viewport width with no side gutter", async ({ page }) => {
    await mountPhoneSession(page);
    await openQuestionCard(page, SHORT_QUESTIONS);

    const box = (await page.locator(".prompt-card").boundingBox())!;
    expect(box.x).toBe(0);
    expect(box.width).toBe(PHONE.width);
  });

  test("tool-permission card renders full-bleed at mobile width too (shared shell)", async ({ page }) => {
    await mountPhoneSession(page);
    await page.evaluate(async () => {
      const pc = await import("/views/sessions/permission-modal/permission-card.ts");
      pc.showPermissionCard({
        id: "p-1", session_id: "s1", tool_name: "Bash",
        input: { command: "echo hi" },
      } as never);
    });
    const card = page.locator(".prompt-card");
    await expect(card).toBeVisible();
    await expect(card.locator(".prompt-card__tool")).toContainText("Bash");
    const box = (await card.boundingBox())!;
    expect(box.x).toBe(0);
    expect(box.width).toBe(PHONE.width);
  });

  test("drag handle: dragging down past the halfway point peeks the card", async ({ page }) => {
    await mountPhoneSession(page);
    await openQuestionCard(page, TALL_QUESTIONS);

    const card = page.locator(".prompt-card");
    const openBox = (await card.boundingBox())!;
    const handleBox = (await card.locator(".prompt-card__handle").boundingBox())!;
    const hx = handleBox.x + handleBox.width / 2;
    const hy = handleBox.y + handleBox.height / 2;

    await page.mouse.move(hx, hy);
    await page.mouse.down();
    // Well past the drag's own halfway-of-peek threshold - see drag-handle.ts.
    await page.mouse.move(hx, hy + openBox.height * 0.6, { steps: 8 });
    await page.mouse.up();

    await expect(card).toHaveClass(/prompt-card--peeked/);
    const peekedBox = (await card.boundingBox())!;
    expect(peekedBox.y).toBeGreaterThan(openBox.y);
  });

  test("drag handle: dragging back up past halfway restores the open card", async ({ page }) => {
    await mountPhoneSession(page);
    await openQuestionCard(page, TALL_QUESTIONS);

    const card = page.locator(".prompt-card");
    const openBox = (await card.boundingBox())!;
    const handleBox = (await card.locator(".prompt-card__handle").boundingBox())!;
    const hx = handleBox.x + handleBox.width / 2;
    const hy = handleBox.y + handleBox.height / 2;

    await page.mouse.move(hx, hy);
    await page.mouse.down();
    await page.mouse.move(hx, hy + openBox.height * 0.6, { steps: 8 });
    await page.mouse.up();
    await expect(card).toHaveClass(/prompt-card--peeked/);

    // Handle has moved down with the peeked card - re-locate before dragging back.
    const peekedHandleBox = (await card.locator(".prompt-card__handle").boundingBox())!;
    const py = peekedHandleBox.y + peekedHandleBox.height / 2;
    await page.mouse.move(hx, py);
    await page.mouse.down();
    await page.mouse.move(hx, py - openBox.height * 0.6, { steps: 8 });
    await page.mouse.up();

    await expect(card).not.toHaveClass(/prompt-card--peeked/);
  });

  test("a tap on the handle restores a peeked card - reachability guarantee", async ({ page }) => {
    await mountPhoneSession(page);
    await openQuestionCard(page, TALL_QUESTIONS);

    const card = page.locator(".prompt-card");
    const openBox = (await card.boundingBox())!;
    const handleBox = (await card.locator(".prompt-card__handle").boundingBox())!;
    const hx = handleBox.x + handleBox.width / 2;
    const hy = handleBox.y + handleBox.height / 2;

    await page.mouse.move(hx, hy);
    await page.mouse.down();
    await page.mouse.move(hx, hy + openBox.height * 0.6, { steps: 8 });
    await page.mouse.up();
    await expect(card).toHaveClass(/prompt-card--peeked/);

    const peekedHandleBox = (await card.locator(".prompt-card__handle").boundingBox())!;
    await page.mouse.click(peekedHandleBox.x + peekedHandleBox.width / 2, peekedHandleBox.y + peekedHandleBox.height / 2);

    await expect(card).not.toHaveClass(/prompt-card--peeked/);
  });

  test("dragging inside the scrollable body does not move the card (no fight with overflow-y scroll)", async ({ page }) => {
    await mountPhoneSession(page);
    await openQuestionCard(page, TALL_QUESTIONS);

    const card = page.locator(".prompt-card");
    const openBox = (await card.boundingBox())!;
    const body = card.locator(".prompt-card__body, .prompt-track-viewport").first();
    const bodyBox = (await body.boundingBox())!;
    const bx = bodyBox.x + bodyBox.width / 2;
    const by = bodyBox.y + Math.min(20, bodyBox.height / 2);

    await page.mouse.move(bx, by);
    await page.mouse.down();
    await page.mouse.move(bx, by + 120, { steps: 8 });
    await page.mouse.up();

    // A handful of px of reflow jitter from the real scroll is expected (the
    // body's own content height sync runs on scroll too) - the guard here is
    // "no drag-sized jump", not pixel-perfect stasis.
    const afterBox = (await card.boundingBox())!;
    expect(Math.abs(afterBox.y - openBox.y)).toBeLessThan(20);
    await expect(card).not.toHaveClass(/prompt-card--peeked/);
  });
});
