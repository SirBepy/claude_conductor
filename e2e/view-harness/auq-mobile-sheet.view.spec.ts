// Reviewed 2026-10-08: index.ts's confirmQuestionRendered calls and permission-card.ts's respond_permission calls now also thread the prompt's sessionId (multi-machine prompt routing, docs/multi-machine.md) - additive, no UI-behavior change for this spec's contract.
// Reviewed 2026-10-08: index.ts gained a `secret-requested` prompt route and queue (the request_secret MCP tool's masked-value card) alongside the existing permission/question routes - additive, no change to this spec's AUQ contract.
// Reviewed 2026-10-20: index.ts gained a `hydrateWrapUpOnDone()` call at install time and re-exports isWrapUpOnDone/setWrapUpOnDone - additive, no change to this spec's AUQ contract.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { assistantMsg, mountView, SESSIONS_BASE_INVOKE, sessionInstance, userMsg, waitForPaneSettled } from "./harness";

// Mobile bottom-sheet redesign (Joe's ask, 2026-08-14): full-bleed, taller,
// guaranteed nav-bar clearance, drag-down-to-peek. Mounts a REAL sessions
// view (not a bare .session-composer stub) so header/composer geometry comes
// from the actual cascade - this is also what proves --composer mode (task 5).

const PHONE = { width: 393, height: 852 };

const SESSION = sessionInstance();

async function mountPhoneSession(page: Page, events: unknown[] = []): Promise<void> {
  await page.setViewportSize(PHONE);
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      load_history_page: { events, oldest_seq: 0, newest_seq: events.length, has_more: false },
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().waitFor();
  await page.locator("#sessions-list li[data-session-id='s1']").click();
  await page.locator("#session-pane .session-composer").waitFor();
  await waitForPaneSettled(page);
}

async function overrideSafeArea(page: Page, bottom: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", {
    insets: { bottom, bottomMax: bottom },
  } as never);
}

// The card settles through a 0.22s transform transition (permission-modal-shell.css
// :114), so a box read mid-flight is stale by the time mouse.down lands - measured
// ~12px of drift against a 22px handle, which is how the press missed the handle
// outright and left the card peeked (todo 725). Wait for the rect to stop moving.
async function settledBox(loc: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  await loc.evaluate((el) => new Promise<void>((resolve) => {
    let last = Number.NaN;
    const tick = (): void => {
      const y = el.getBoundingClientRect().top;
      if (Math.abs(y - last) < 0.01) { resolve(); return; }
      last = y;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  return (await loc.boundingBox())!;
}

const SHORT_QUESTIONS = [{ question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] }];

const MANY_OPTIONS = Array.from({ length: 14 }, (_, i) => ({
  label: `Option ${i + 1} with a longer label to pad it out`,
  description: "A fairly long description line to pad this option's rendered height out.",
}));
const TALL_QUESTIONS = [
  { question: "Which approach, given all the constraints in play here?", header: "Approach", options: MANY_OPTIONS },
];

// The phone question page has no drag handle; the permission card still peeks.
async function openPermissionCard(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const pc = await import("/views/sessions/permission-modal/permission-card.ts");
    pc.showPermissionCard({ id: "p-1", session_id: "s1", tool_name: "Bash", input: { command: "echo hi" } } as never);
  });
  await page.locator(".prompt-card").waitFor();
}

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
  test("fullscreen: card covers the whole viewport and the header/statusbar unmount", async ({ page }) => {
    await mountPhoneSession(page);
    await openQuestionCard(page, TALL_QUESTIONS);
    await page.waitForTimeout(200); // settle the entrance animation (translateY 6px -> 0)

    const cardBox = (await page.locator(".prompt-card").boundingBox())!;
    expect(cardBox.y).toBe(0);
    expect(cardBox.height).toBe(PHONE.height);
    await expect(page.locator(".session-header")).toBeHidden();
    await expect(page.locator(".session-statusbar")).toBeHidden();
  });

  // The chat pane's slide-in transform is the fixed sheet's containing block,
  // and the pane already sits inside body's nav-bar band - adding the inset
  // again left a strip of composer showing under the sheet on the phone.
  test("fullscreen: sheet reaches the pane bottom under a safe-area inset, no composer strip", async ({ page }) => {
    await mountPhoneSession(page);
    await overrideSafeArea(page, 48);
    await openQuestionCard(page, SHORT_QUESTIONS);

    const cardBox = await settledBox(page.locator(".prompt-card"));
    const paneBox = (await page.locator("#session-pane").boundingBox())!;
    expect(cardBox.y + cardBox.height).toBeCloseTo(paneBox.y + paneBox.height, 0);
  });

  test("fullscreen: the composer's own input is hidden while the sheet is up", async ({ page }) => {
    await mountPhoneSession(page);
    await openQuestionCard(page, SHORT_QUESTIONS);
    await expect(page.locator(".session-composer textarea").first()).toBeHidden();
  });

  test("phone page: back arrow returns to the chat, latest messages showing above the collapsed bar", async ({ page }) => {
    const events = Array.from({ length: 12 }, (_, i) => [userMsg(`question ${i}`), assistantMsg(`answer ${i}`)]).flat();
    await mountPhoneSession(page, events);
    await openQuestionCard(page, SHORT_QUESTIONS);
    await expect(page.locator(".prompt-card__handle")).toBeHidden();
    await expect(page.locator('.prompt-card [data-act="minimize"]')).toBeHidden();

    await page.locator('.prompt-card [data-act="back"]').click();

    const bar = page.locator(".prompt-collapsed");
    await expect(bar).toBeVisible();
    await expect(page.locator(".session-composer textarea").first()).toBeVisible();
    const barBox = await settledBox(bar);
    const lastBox = (await page.locator(".session-messages .msg.user", { hasText: "question 11" }).boundingBox())!;
    expect(lastBox.y).toBeGreaterThanOrEqual(0);
    expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(barBox.y);
  });

  // Joe, 2026-10-22: raised header/footer bars around the content, Skip +
  // Submit above an answer box styled exactly like the Preview composer.
  test("phone page: Skip/Submit sit above the Preview panel's own reply bar, input and send arrow on one row", async ({ page }) => {
    await mountPhoneSession(page);
    await openQuestionCard(page, SHORT_QUESTIONS);

    const primary = await settledBox(page.locator('.prompt-card__footer [data-act="primary"]'));
    // The Preview reply bar's own markup, not a restyled AUQ field.
    const bar = page.locator(".prompt-card__answer-bar > .pv-composer");
    const field = bar.locator(".composer-input-wrap > textarea.composer-textarea.prompt-q__other-input");
    const send = bar.locator(".pv-composer-send");
    await expect(field).toBeVisible();
    const barBox = (await bar.boundingBox())!;
    expect(barBox.y).toBeGreaterThanOrEqual(primary.y + primary.height);

    // Inline: the arrow sits beside the field, inside its vertical span.
    const fieldBox = (await field.boundingBox())!;
    const sendBox = (await send.boundingBox())!;
    expect(sendBox.x).toBeGreaterThanOrEqual(fieldBox.x + fieldBox.width);
    expect(sendBox.y).toBeGreaterThanOrEqual(fieldBox.y - 1);
    expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(fieldBox.y + fieldBox.height + 1);
    // Full-bleed like the Preview panel's, edge to edge of the screen.
    expect(barBox.x).toBe(0);
    expect(barBox.width).toBe(PHONE.width);

    await expect(send).toBeDisabled();
    await field.fill("my own answer");
    await expect(send).toBeEnabled();
  });

  test("phone page: header and footer bars are a different color from the content", async ({ page }) => {
    await mountPhoneSession(page);
    await openQuestionCard(page, SHORT_QUESTIONS);
    const colors = await page.evaluate(() => {
      const bg = (sel: string) => getComputedStyle(document.querySelector(sel)!).backgroundColor;
      return { head: bg(".prompt-card__header"), foot: bg(".prompt-card__footer"), card: bg(".prompt-card"), body: bg("body") };
    });
    expect(colors.head).toBe(colors.foot);
    expect(colors.head).not.toBe(colors.card);
    // The system-bar bands (body's padding) match the bars, not the content.
    expect(colors.body).toBe(colors.head);
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

    const box = await settledBox(page.locator(".prompt-card"));
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
    const box = await settledBox(card);
    expect(box.x).toBe(0);
    expect(box.width).toBe(PHONE.width);
  });

  test("drag handle: dragging down past the halfway point peeks the card", async ({ page }) => {
    await mountPhoneSession(page);
    await openPermissionCard(page);

    const card = page.locator(".prompt-card");
    const openBox = await settledBox(card);
    const handleBox = await settledBox(card.locator(".prompt-card__handle"));
    const hx = handleBox.x + handleBox.width / 2;
    const hy = handleBox.y + handleBox.height / 2;

    await page.mouse.move(hx, hy);
    await page.mouse.down();
    // Well past the drag's own halfway-of-peek threshold - see drag-handle.ts.
    await page.mouse.move(hx, hy + openBox.height * 0.6, { steps: 8 });
    await page.mouse.up();

    await expect(card).toHaveClass(/prompt-card--peeked/);
    const peekedBox = await settledBox(card);
    expect(peekedBox.y).toBeGreaterThan(openBox.y);
  });

  test("drag handle: dragging back up past halfway restores the open card", async ({ page }) => {
    await mountPhoneSession(page);
    await openPermissionCard(page);

    const card = page.locator(".prompt-card");
    const openBox = await settledBox(card);
    const handleBox = await settledBox(card.locator(".prompt-card__handle"));
    const hx = handleBox.x + handleBox.width / 2;
    const hy = handleBox.y + handleBox.height / 2;

    await page.mouse.move(hx, hy);
    await page.mouse.down();
    await page.mouse.move(hx, hy + openBox.height * 0.6, { steps: 8 });
    await page.mouse.up();
    await expect(card).toHaveClass(/prompt-card--peeked/);

    // Handle has moved down with the peeked card - re-locate before dragging back.
    const peekedHandleBox = await settledBox(card.locator(".prompt-card__handle"));
    const py = peekedHandleBox.y + peekedHandleBox.height / 2;
    await page.mouse.move(hx, py);
    await page.mouse.down();
    await page.mouse.move(hx, py - openBox.height * 0.6, { steps: 8 });
    await page.mouse.up();

    await expect(card).not.toHaveClass(/prompt-card--peeked/);
  });

  test("a tap on the handle restores a peeked card - reachability guarantee", async ({ page }) => {
    await mountPhoneSession(page);
    await openPermissionCard(page);

    const card = page.locator(".prompt-card");
    const openBox = await settledBox(card);
    const handleBox = await settledBox(card.locator(".prompt-card__handle"));
    const hx = handleBox.x + handleBox.width / 2;
    const hy = handleBox.y + handleBox.height / 2;

    await page.mouse.move(hx, hy);
    await page.mouse.down();
    await page.mouse.move(hx, hy + openBox.height * 0.6, { steps: 8 });
    await page.mouse.up();
    await expect(card).toHaveClass(/prompt-card--peeked/);

    const peekedHandleBox = await settledBox(card.locator(".prompt-card__handle"));
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
