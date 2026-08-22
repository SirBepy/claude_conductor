import { expect, test, type Page } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";

// Todo 699: the thinking-bar/composer fusion (b167f0e7) and the AUQ
// extra-message padding (236274b6) shipped on mockup review alone. These shots
// put the real cascade on screen so the seam can be judged from pixels.

const DESKTOP = { width: 1200, height: 820 };

// No turn_usage: the turn stays OPEN, so the thinking bar keeps its label.
function openTurnTranscript(): { events: unknown[]; oldest_seq: number; newest_seq: number; has_more: boolean } {
  return {
    events: [
      { type: "user_message", content: [{ type: "text", text: "Wire the composer seam." }], timestamp: 0, remote_echo: false, is_meta: false },
      { type: "assistant_message", content: [{ type: "text", text: "On it - reading the stylesheet first." }], timestamp: 0 },
      { type: "tool_use", tool_name: "Read", input: { file_path: "src/views/sessions/sessions.css" }, id: "tu-read-1", timestamp: 0, parent_tool_use_id: null },
    ],
    oldest_seq: 0,
    newest_seq: 0,
    has_more: false,
  };
}

async function mountChat(page: Page, busy: boolean): Promise<void> {
  const sess = sessionInstance(busy ? { busy: true, awaiting: null } : { busy: false, awaiting: "done" });
  await page.setViewportSize(DESKTOP);
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [sess],
      get_active_sessions: [sess],
      load_history_page: openTurnTranscript(),
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().click();
  await page.locator("#session-pane .session-composer").first().waitFor();
}

test.describe("@shot", () => {
  test.skip(!process.env.CC_SHOTS, "capture-only, run it with CC_SHOTS=1");

  test("composer, thinking bar up mid-turn", async ({ page }) => {
    await mountChat(page, true);

    const shell = page.locator("#session-pane .composer-shell");
    const thinking = shell.locator(".session-thinking");
    const composer = shell.locator(".session-composer");
    await expect(thinking).toBeVisible();
    await expect(thinking.locator(".thinking-text")).not.toHaveText("");
    await expect(composer).toBeVisible();

    // Fused = the bar's bottom edge IS the composer's top edge, same column.
    const bar = (await thinking.boundingBox())!;
    const box = (await composer.boundingBox())!;
    expect(Math.abs(bar.y + bar.height - box.y)).toBeLessThan(1.5);
    expect(Math.abs(bar.x - box.x)).toBeLessThan(1.5);
    expect(Math.abs(bar.width - box.width)).toBeLessThan(1.5);
    await expect(thinking).toHaveCSS("border-bottom-left-radius", "0px");

    await capture(shell, "composer-thinking-mid-turn");
  });

  test("composer, idle", async ({ page }) => {
    await mountChat(page, false);

    const shell = page.locator("#session-pane .composer-shell");
    await expect(shell).toBeVisible();
    await expect(shell.locator(".session-thinking")).toBeHidden();
    // Sole visible child, so the composer takes the full 8px rounding back.
    await expect(shell.locator(".session-composer")).toHaveCSS("border-top-left-radius", "8px");

    await capture(shell, "composer-idle");
  });

  test("AUQ review step, extra-message field", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await mountView(page, { invoke: { respond_question: null } });

    await page.evaluate(async () => {
      const qm = await import("/views/sessions/permission-modal/index.ts");
      const sm = await import("/views/sessions/state.ts");
      const sid = "sess-1";
      sm.state.selectedId = sid;
      qm.setSelectedSessionId(sid);

      const pane = document.createElement("div");
      pane.innerHTML = '<div class="session-composer"></div>';
      document.body.appendChild(pane);

      qm.handleQuestionRequested({
        id: "q1",
        session_id: sid,
        questions: [
          { question: "Which lane should the builder take?", header: "Lane", options: [{ label: "Inline" }, { label: "Subagent" }] },
          { question: "Ship it behind a flag?", header: "Flag", options: [{ label: "Yes" }, { label: "No" }] },
        ],
      });
    });

    const card = page.locator(".prompt-card");
    await expect(card).toBeVisible();
    await card.locator('.prompt-opt input[data-label="Inline"]').click();
    await expect(card.locator(".prompt-panel.is-active .prompt-q__text")).toHaveText("Ship it behind a flag?");
    await card.locator('.prompt-opt input[data-label="Yes"]').click();
    await card.locator('.prompt-pager [data-nav="1"]').click();

    const extra = card.locator(".prompt-extra-message");
    await expect(extra).toBeVisible();
    await expect(extra).toContainText("Add a message");
    const input = extra.locator(".prompt-extra-input");
    await expect(input).toBeVisible();
    expect((await input.boundingBox())!.height).toBeGreaterThan(20);

    await capture(extra, "auq-extra-message-padding");
    await capture(card, "auq-extra-message-card");
  });
});
