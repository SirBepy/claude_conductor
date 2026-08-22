import { expect, test, type Page } from "@playwright/test";
import { SESSIONS_BASE_INVOKE, capture, mountView, sessionInstance } from "./harness";
import type { Instance } from "../../src/types/ipc.generated";
import type { Question } from "../../src/views/sessions/permission-modal/types";

// Todo 658: renders the three reachable changes from the 2026-08-16 backlog
// run (646 card header, 638 badge counts, 632 takeover alert) so they can be
// eyeballed. 635 is already covered by statusbar-scroll-fade.view.spec.ts.

const DESKTOP = { width: 1200, height: 820 };

const QUESTION: Question = {
  question: "Pasting an image into this card is not supported. Which approach?",
  header: "Approach",
  domain: "ux",
  options: [
    { label: "Attach from disk", description: "opens a file picker", badges: ["recommended"] },
    { label: "Skip the image", description: "answer with text only", badges: ["short_term"] },
  ],
};

interface CardCfg {
  question: Question;
  rightChipHtml?: string;
  degraded: boolean;
}

async function renderCard(page: Page, cfg: CardCfg) {
  await page.evaluate(async (c) => {
    const mod = await import("/views/sessions/permission-modal/question-ui.ts");
    mod.renderQuestionUI({
      questions: [c.question],
      titleIcon: "ph-chat-circle-dots",
      rightChipHtml: c.rightChipHtml,
      degradedBuiltin: c.degraded,
      submitLabel: "Submit",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      supportsExtras: true,
      onSubmit: () => {},
      onCancel: () => {},
    });
  }, cfg);
  return page.locator(".prompt-card");
}

function schedItem(sessionId: string) {
  return {
    id: "sch-1",
    kind: { type: "message", session_id: sessionId, cwd: "C:/Projects/alpha" },
    prompt: "ping",
    fire_at: "2026-09-01T10:00:00Z",
    recurrence: null,
    status: { type: "pending" },
    created_at: "2026-08-20T10:00:00Z",
    last_fired_at: null,
    last_result: null,
    last_session_id: null,
  };
}

/** mountSessionsList can't reach this case: the badge's data source is
 *  `schedule_list`, which SESSIONS_BASE_INVOKE does not mock. */
async function mountRows(
  page: Page,
  sessions: Instance[],
  rowStyle: "classic" | "portrait",
  extra: Record<string, unknown> = {},
): Promise<void> {
  await page.addInitScript((v) => localStorage.setItem("cc_chat_row_style", v), rowStyle);
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: sessions,
      get_active_sessions: sessions,
      ...extra,
    },
  });
  await page.locator("#sessions-list li").first().waitFor();
}

test.describe("@shot", () => {
  test.skip(!process.env.CC_SHOTS, "capture-only, run it with CC_SHOTS=1");

  test("646 - MCP vs degraded question-card header", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await mountView(page, { invoke: { list_slash_commands: [] } });

    const mcp = await renderCard(page, { question: QUESTION, degraded: false });
    await expect(mcp).toBeVisible();
    await expect(mcp).toContainText("Which approach?");
    await expect(mcp.locator(".prompt-card__title i")).toHaveClass(/ph-chat-circle-dots/);
    await expect(mcp.locator(".question-card-degraded-badge")).toHaveCount(0);
    await expect(mcp.locator(".prompt-card__tool")).toHaveCount(0);
    await capture(mcp, "question-card-mcp-header");

    const degraded = await renderCard(page, { question: QUESTION, degraded: true });
    await expect(degraded).toBeVisible();
    await expect(degraded).toContainText("Which approach?");
    await expect(degraded.locator(".prompt-card__title i")).toHaveClass(/ph-chat-circle-dots/);
    await expect(degraded.locator(".question-card-degraded-badge")).toHaveCount(1);
    await capture(degraded, "question-card-degraded-header");

    // rightChipHtml's only live caller is permission-card.ts's question-shaped
    // fallback for a NON-AskUserQuestion tool, never the degraded path.
    const chip = await renderCard(page, {
      question: QUESTION,
      rightChipHtml: `<span class="prompt-card__tool"><code>ExitPlanMode</code></span>`,
      degraded: false,
    });
    await expect(chip.locator(".prompt-card__tool code")).toHaveText("ExitPlanMode");
    await capture(chip, "question-card-fallback-tool-chip");
  });

  // A sidebar row is ~50px tall; shot at 1x the badge glyph is unreadable.
  test.describe("638", () => {
    test.use({ deviceScaleFactor: 3 });

    for (const style of ["classic", "portrait"] as const) {
      test(`count-hiding rule, ${style} rows`, async ({ page }) => {
        await page.setViewportSize(DESKTOP);
        const sessions = [
          sessionInstance({ session_id: "s1", name: "Scheduled one", cwd: "C:/Projects/alpha" }),
          sessionInstance({ session_id: "s2", name: "Held one", cwd: "C:/Projects/beta", held_count: 1 }),
        ];
        await mountRows(page, sessions, style, { schedule_list: [schedItem("s1")] });

        const schedRow = page.locator('li[data-session-id="s1"]');
        const heldRow = page.locator('li[data-session-id="s2"]');
        const schedMarker = schedRow.locator(
          style === "portrait" ? ".session-sched-corner" : ".session-scheduled-badge",
        );
        const heldMarker = heldRow.locator(
          style === "portrait" ? ".session-held-corner" : ".session-held-badge",
        );

        await expect(schedMarker).toBeVisible();
        await expect(schedMarker.locator("i")).toHaveClass(/ph-clock-countdown/);
        await expect(
          schedRow.locator(style === "portrait" ? ".session-sched-count" : ".session-scheduled-count"),
        ).toHaveCount(0);
        await capture(schedRow, `badge-scheduled-count-1-${style}`);

        await expect(heldMarker).toBeVisible();
        await expect(heldMarker.locator("i")).toHaveClass(/ph-paper-plane-tilt/);
        await expect(heldRow.locator(".session-held-count")).toHaveText("1");
        await capture(heldRow, `badge-held-count-1-${style}`);
      });
    }
  });

  test("632 - takeover on an unreachable command shows the friendly alert", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const sess = sessionInstance({ session_id: "s1", kind: "external", name: "Manual claude" });
    await mountRows(page, [sess], "classic", {
      load_history_page: { events: [], oldest_seq: 0, newest_seq: 0, has_more: false },
      list_slash_commands: [],
      list_accounts: [{ id: "acc-1", label: "Personal", colour: "#8b5cf6", icon: "user" }],
      context_status: null,
      instance_token_stats: null,
      get_git_dirty: null,
    });
    // Segment 7 ("Remote", where kind:external lands) is default-collapsed.
    await page.locator('li[data-seg-toggle="7"]').click();
    await page.locator('li[data-session-id="s1"]').click();

    const takeover = page.locator(".readonly-banner .takeover-btn");
    await expect(takeover).toBeVisible();
    await capture(page.locator(".readonly-banner"), "takeover-readonly-banner");

    await page.evaluate(async () => {
      const mod = await import("/shared/http-transport.ts");
      const core = (window as unknown as {
        __TAURI__: { core: { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> } };
      }).__TAURI__.core;
      const orig = core.invoke;
      core.invoke = (cmd, args) =>
        cmd === "takeover_manual"
          ? Promise.reject(new mod.RemoteUnavailableError("takeover_manual"))
          : orig(cmd, args);
    });

    let dialogText: string | null = null;
    page.on("dialog", (d) => {
      dialogText = d.message();
      void d.dismiss();
    });

    await takeover.click();
    await page.locator(".app-confirm-ok").click();
    await page.locator(".cam-account-list .account-chip").first().click();

    await expect.poll(() => dialogText).not.toBeNull();
    expect(dialogText).toBe("Not available on this device.");
  });
});
