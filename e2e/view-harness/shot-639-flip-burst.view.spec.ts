import { expect, test, type Page } from "@playwright/test";
import { SESSIONS_BASE_INVOKE, capture, mountView, sessionInstance } from "./harness";

// todo 639: interrupting a busy chat used to drop its sidebar row toward the
// bottom before it settled back into an unchanged slot. Drives the REAL
// composer -> held-chip -> cancel_turn/send_message path and reconstructs the
// daemon's two back-to-back instances-changed broadcasts around it.

const DESKTOP = { width: 1400, height: 900 };

/** How long after `send_message` the busy=true broadcast lands. The rising
 *  FLIP runs 340ms, so this puts reconcile #2 squarely mid-flight. */
const SECOND_RECONCILE_MS = 120;

// Project names sort alpha < mango < zulu, so the busy row leaves the bottom
// ("In Progress") for the TOP of "Done" when it goes idle: a long, obvious move.
const SESSIONS = [
  sessionInstance({ session_id: "s1", cwd: "C:/Projects/alpha", name: "Alpha chat", busy: true }),
  sessionInstance({ session_id: "s2", pid: 101, cwd: "C:/Projects/mango", name: "Mango chat" }),
  sessionInstance({ session_id: "s3", pid: 102, cwd: "C:/Projects/zulu", name: "Zulu chat" }),
];

const STAMP = "2026-08-22T10:00:00Z";
const INVOKE = {
  ...SESSIONS_BASE_INVOKE,
  list_instances: SESSIONS,
  get_active_sessions: SESSIONS,
  load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
  get_session_drafts: { composer: null, auq: null, held: [], held_updated_at: null },
  add_held_message: { id: 1, updated_at: STAMP },
  update_held_message: { updated_at: STAMP },
  remove_held_message: { updated_at: STAMP },
  clear_held_messages: { updated_at: STAMP },
  set_composer_draft: { updated_at: STAMP },
  clear_composer_draft: { updated_at: STAMP },
  cancel_turn: null,
  send_message: null,
};

const ROW = '#sessions-list li[data-session-id="s1"]';

/** Boot the sessions view, open the busy chat, and stage one held message so
 *  the chip's "Send now" (the real interrupt trigger) is live. */
async function mountAndStage(page: Page): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await page.addInitScript(() => localStorage.setItem("cc_chat_row_style", "classic"));
  await mountView(page, { view: "sessions", invoke: INVOKE });

  const row = page.locator(ROW);
  await expect(row).toBeVisible();
  await expect(row).toContainText("alpha");
  await row.click();

  const textarea = page.locator("#session-pane .session-composer textarea");
  await expect(textarea).toBeVisible();
  await textarea.fill("interrupt and take this instead");
  await textarea.press("Enter");

  await expect(page.locator("#session-pane .held-send-now")).toBeVisible();
}

/** Replace the mocked invoke so `cancel_turn` / `send_message` each re-broadcast
 *  the session list through the real refreshSessions + renderSidebar, exactly
 *  as the daemon's instances-changed does. */
async function armDaemonBroadcasts(page: Page): Promise<void> {
  await page.evaluate(
    async ({ sessions, gap }) => {
      const w = window as unknown as Record<string, unknown>;
      const sidebar = await import("/views/sessions/sidebar.ts");
      let busy = true;
      const reconciles: number[] = [];
      w.__ccReconciles = reconciles;
      const listNow = () =>
        (sessions as Array<Record<string, unknown>>).map((s) =>
          s.session_id === "s1" ? { ...s, busy } : s,
        );
      const broadcast = (next: boolean, delay: number) => {
        setTimeout(() => {
          busy = next;
          void sidebar.refreshSessions().then(() => {
            sidebar.renderSidebar(document.querySelector<HTMLElement>("#sessions-list")!);
            reconciles.push(Math.round(performance.now() - ((w.__ccT0 as number) ?? 0)));
          });
        }, delay);
      };
      const core = (window as unknown as { __TAURI__: { core: { invoke: unknown } } }).__TAURI__.core;
      const orig = core.invoke as (c: string, a?: unknown) => Promise<unknown>;
      core.invoke = (cmd: string, args?: unknown) => {
        if (cmd === "list_instances" || cmd === "get_active_sessions") {
          return Promise.resolve(listNow());
        }
        if (cmd === "cancel_turn") { broadcast(false, 0); return Promise.resolve(null); }
        if (cmd === "send_message") { broadcast(true, gap); return Promise.resolve(null); }
        return orig(cmd, args);
      };
    },
    { sessions: SESSIONS, gap: SECOND_RECONCILE_MS },
  );
}

/** Fire the chip's Send now without Playwright's actionability round-trip, so
 *  a burst started right after this begins on the same frame as the interrupt. */
async function fireInterrupt(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>("#session-pane .held-send-now")!.click();
  });
}

test.describe("@shot", () => {
  test.skip(!process.env.CC_SHOTS, "capture-only, run it with CC_SHOTS=1");

  test("per-frame Y trace of the busy row across a real interrupt", async ({ page }) => {
    await mountAndStage(page);
    await armDaemonBroadcasts(page);

    const restY = (await page.locator(ROW).boundingBox())!.y;
    const listBottom = (await page.locator("#sessions-list").boundingBox())!;

    await page.evaluate((sel) => {
      const w = window as unknown as Record<string, unknown>;
      const trace: Array<[number, number]> = [];
      w.__ccTrace = trace;
      const t0 = performance.now();
      w.__ccT0 = t0;
      const step = () => {
        const li = document.querySelector(sel);
        if (li) trace.push([Math.round(performance.now() - t0), Math.round(li.getBoundingClientRect().top)]);
        if (performance.now() - t0 < 800) requestAnimationFrame(step);
        else w.__ccTraceDone = true;
      };
      requestAnimationFrame(step);
    }, ROW);

    await fireInterrupt(page);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __ccTraceDone?: boolean }).__ccTraceDone === true), { timeout: 5_000 }).toBe(true);

    const trace = await page.evaluate(() => (window as unknown as { __ccTrace: Array<[number, number]> }).__ccTrace);
    const reconciles = await page.evaluate(() => (window as unknown as { __ccReconciles: number[] }).__ccReconciles);
    const tops = trace.map(([, y]) => y);
    console.log(`[639] rest-y=${Math.round(restY)} list=[${Math.round(listBottom.y)}..${Math.round(listBottom.y + listBottom.height)}] viewport-h=${DESKTOP.height}`);
    console.log(`[639] reconciles=${reconciles.length} trace=${JSON.stringify(trace)}`);
    const settled = tops[tops.length - 1] ?? -1;
    console.log(`[639] min=${Math.min(...tops)} max=${Math.max(...tops)} settled=${settled}`);

    expect(reconciles.length, "both daemon broadcasts must land").toBe(2);
    // Vacuous-pass guard: a flat trace would mean the FLIP never ran.
    expect(Math.max(...tops) - Math.min(...tops), "the FLIP must actually animate").toBeGreaterThan(30);
    // The bounce bezier overshoots ~10% of a ~130px move, hence 40px of slack.
    expect(Math.max(...tops), "no drop below the row's own resting slot").toBeLessThan(restY + 40);
    expect(Math.abs(settled - restY), "settles back where it started").toBeLessThan(4);

    // The commit e6ecb07c check itself. Reconcile #2's FLIP inverts the row to
    // whatever `beforeRects` measured, so that on-screen Y IS the measurement:
    // the cleared resting slot (== the trace minimum) if clearFlipState ran on
    // survivors, or the half-animated Y one frame earlier if it did not.
    const r2 = reconciles[1] ?? -1;
    const midFlight = [...trace].reverse().find(([t]) => t < r2)!;
    const inverted = trace.find(([t]) => t >= r2 + 20)!;
    console.log(`[639] reconcile2@${r2}ms mid-flight-y=${midFlight[1]} inverted-y=${inverted[1]} slot-y=${Math.min(...tops)}`);
    expect(inverted[1], "reconcile #2 measured the resting slot, not the half-animated Y")
      .toBeLessThan(midFlight[1] - 20);
    expect(Math.abs(inverted[1] - Math.min(...tops)), "and that slot is the row's real Done-segment slot")
      .toBeLessThan(4);

    const row = page.locator(ROW);
    await expect(row).toBeVisible();
    await expect(row).toContainText("alpha");
    await capture(page.locator(".sessions-sidebar"), "flip-639-settled");
  });

  test("burst across the interrupt transition", async ({ page }) => {
    await mountAndStage(page);
    await armDaemonBroadcasts(page);

    const row = page.locator(ROW);
    const list = page.locator("#sessions-list");
    await expect(list).toBeVisible();
    const restY = (await row.boundingBox())!.y;
    const frames: Array<{ t: number; y: number }> = [];

    const t0 = Date.now();
    await fireInterrupt(page);
    for (let i = 0; i < 8; i++) {
      const box = await row.boundingBox();
      expect(box, `frame ${i}: the busy row must still be laid out`).not.toBeNull();
      frames.push({ t: Date.now() - t0, y: Math.round(box!.y) });
      await capture(list, `flip-burst-${i}`);
    }

    console.log(`[639] rest-y=${Math.round(restY)} burst=${JSON.stringify(frames)}`);
    expect(frames.every((f) => f.y < restY + 40), "no frame drops below the resting slot").toBe(true);
    await expect(row).toContainText("alpha");
    await capture(list, "flip-burst-final");
  });
});
