// Reviewed 2026-11-11 (plan-card-lifecycle): the bar gained a hidden .thinking-icon and, in Dashboard view only, says the action instead of the plan step and opens to the turn's calls; this spec runs in Messages view and passes.
// Reviewed 2026-11-10 (dash lane 3): the Subchats card, Pin to sidemenu (replacing Move to sidebar in the chat menu) and the effort battery colours change nothing this spec asserts; it passes.
// Reviewed 2026-11-10: the question card pads the scroller cardPaddedScroller picks (this pane's transcript as before, or the chat dashboard's body while it shows), active-session.ts detaches the chat dashboard on dismount, and a read-only session keeps Messages; nothing this spec asserts changed, and it passes.
// Reviewed 2026-11-10: flushRender fires onFlushed, and the chat dashboard can move the status line into its Plan card in Dashboard view only; the harness pins Messages view and this spec passes.
// Reviewed 2026-11-05: quiet daemon cards (a checkup yields, no dot), the mode-set nudge, the draft header dressing, the statusbar model sync and the sub-aware /close chip touch permission-modal and the sessions chrome; this spec's contract is unchanged and it passes.
// Reviewed 2026-11-02: the line is --control-h-sm tall on desktop and --control-h on a phone (it was 28 / 40px); the asserts below hold.
// Reviewed 2026-11-03: selectSession now returns when the chat was switched away during the statusbar settings read; this spec's contract is unchanged and it passes.
// asserts: src/views/sessions/session-thinking-bar.ts, src/views/sessions/active-session.ts, src/views/sessions/sessions.css, src/shared/chat/chat-dom-renderer.ts, src/shared/chat/tool-meta.ts
import { expect, test, type Page } from "@playwright/test";
import { capture, invokeCalls, mountView, SESSIONS_BASE_INVOKE, sessionInstance, waitForPaneSettled } from "./harness";

// The working bar above the composer: no card, the whole command readable,
// Stop on hover (desktop) or inside the opened block (touch, which has no hover).
// Joe, 2026-11-01: "not have its own whole card ... hover it and you can cancel".

const COMMAND = 'cat permission-modal-track.css; sed -n 295,325p permission-modal-track.css; rg -n "prompt-card" src/views/sessions -g "*.css" | head -40';

function openTurn() {
  return {
    events: [
      { type: "user_message", content: [{ type: "text", text: "Check the modal." }], timestamp: 0, remote_echo: false, is_meta: false },
      { type: "tool_use", tool_name: "PowerShell", input: { command: COMMAND }, id: "tu-1", timestamp: 0, parent_tool_use_id: null },
    ],
    oldest_seq: 0,
    newest_seq: 0,
    has_more: false,
  };
}

async function mountBusyChat(page: Page): Promise<void> {
  const sess = sessionInstance({ busy: true, awaiting: null });
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [sess],
      get_active_sessions: [sess],
      load_history_page: openTurn(),
      cancel_turn: null,
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().click();
  await page.locator("#session-pane .session-composer").first().waitFor();
  await waitForPaneSettled(page);
  await expect(page.locator("#session-pane .session-thinking")).toBeVisible();
}

const cancelCalls = async (page: Page) => (await invokeCalls(page)).filter((c) => c.cmd === "cancel_turn").length;

test.describe("view-harness / thinking bar (desktop)", () => {
  test.use({ viewport: { width: 1200, height: 820 } });

  test("is one bare line carrying the whole command, not a 60-character cut in a card", async ({ page }) => {
    await mountBusyChat(page);
    const bar = page.locator("#session-pane .session-thinking");
    await expect(bar).toHaveCSS("border-top-width", "0px");
    await expect(bar).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(bar.locator(".thinking-text")).toHaveText(`Running: ${COMMAND}`);
    await expect(bar.locator(".thinking-detail")).toBeHidden();
  });

  test("hover swaps the elapsed time for Stop in the same slot, and Stop ends the turn", async ({ page }) => {
    await mountBusyChat(page);
    const bar = page.locator("#session-pane .session-thinking");
    const stop = bar.locator(".thinking-pause-btn");
    await expect(stop).toHaveCSS("opacity", "0");
    const slotBefore = (await bar.locator(".thinking-slot").boundingBox())!;

    await bar.locator(".thinking-row").hover();
    await expect(stop).toHaveCSS("opacity", "1");
    await expect(bar.locator(".thinking-slot .thinking-elapsed")).toHaveCSS("opacity", "0");
    const slotAfter = (await bar.locator(".thinking-slot").boundingBox())!;
    expect(slotAfter.width).toBe(slotBefore.width);
    expect(slotAfter.x).toBe(slotBefore.x);

    await stop.click();
    await expect.poll(() => cancelCalls(page)).toBe(1);
  });

  test("a click on the line opens the full command with Stop turn, a second click closes it", async ({ page }) => {
    await mountBusyChat(page);
    const bar = page.locator("#session-pane .session-thinking");
    await bar.locator(".thinking-main").click();

    await expect(bar.locator(".thinking-cmd code")).toHaveText(COMMAND);
    await expect(bar.locator(".thinking-meta")).toContainText("PowerShell");
    await expect(bar.locator(".thinking-detail .thinking-elapsed")).toHaveText(/^\d+:\d{2}$/);
    // Above the line, not below it: the line stays put against the composer.
    const detail = (await bar.locator(".thinking-detail").boundingBox())!;
    const row = (await bar.locator(".thinking-row").boundingBox())!;
    expect(detail.y + detail.height).toBeLessThanOrEqual(row.y + 1);
    await capture(page.locator("#session-pane .composer-shell"), "thinking-bar-open-desktop");

    await bar.locator(".thinking-stop-turn").click();
    await expect.poll(() => cancelCalls(page)).toBe(1);

    await bar.locator(".thinking-main").click();
    await expect(bar.locator(".thinking-detail")).toBeHidden();
  });
});

test.describe("view-harness / thinking bar (touch)", () => {
  test.use({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });

  test("has no hover Stop, so a tap opens the block and Stop lives inside it", async ({ page }) => {
    await mountBusyChat(page);
    const bar = page.locator("#session-pane .session-thinking");
    await expect(bar.locator(".thinking-pause-btn")).toBeHidden();
    await expect(bar.locator(".thinking-caret")).toHaveCSS("opacity", "0.6");
    // A phone tap target, not the desktop 28px hairline.
    expect((await bar.locator(".thinking-row").boundingBox())!.height).toBeGreaterThanOrEqual(40);

    await bar.locator(".thinking-main").tap();
    await expect(bar.locator(".thinking-cmd code")).toHaveText(COMMAND);
    await capture(page.locator("#session-pane .composer-shell"), "thinking-bar-open-phone");

    await bar.locator(".thinking-stop-turn").tap();
    await expect.poll(() => cancelCalls(page)).toBe(1);
  });
});
