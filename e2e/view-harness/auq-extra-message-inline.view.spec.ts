import { test, expect } from "@playwright/test";
import { capture, mountView, SESSIONS_BASE_INVOKE, sessionInstance } from "./harness";
import { AUQ_EXTRA_SENTINEL } from "../../src/shared/chat/chat-transforms";

// The card's own "additional message" note now folds into the SAME question
// card (see chat-question-card.ts's resolvePendingQuestionExtra) instead of
// rendering as a separate trailing bubble - visual proof of both states.

const LONG_NOTE = `but basically, frozen also moves it to hidden, but i can take it out of hidden if i want
maybe lets move autofrozen to scheduled? i think it might already be there, but in case its not - and while we're at it, does the "in progress" tag still make sense once frozen sessions live under hidden, or should that get folded too? not sure, just thinking out loud`;

function transcript(): { events: unknown[]; oldest_seq: number; newest_seq: number; has_more: boolean } {
  const events: unknown[] = [
    { type: "user_message", content: [{ type: "text", text: "Frozen placement - fold it into Hidden, or give it its own row?" }], timestamp: 0, remote_echo: false },
    {
      type: "tool_use",
      tool_name: "mcp__cc_conductor__ask_user_question",
      input: { questions: [{ question: "Frozen placement - fold it into Hidden, or give it its own row?", header: "Frozen placement" }] },
      id: "q1",
      timestamp: 0,
      parent_tool_use_id: null,
    },
    {
      type: "tool_result",
      tool_use_id: "q1",
      output: { type: "text", text: "User answered the question(s):\nQ: Frozen placement - fold it into Hidden, or give it its own row?\nA: Fold frozen into Hidden" },
      is_error: false,
      timestamp: 0,
    },
    // The card's own note, delivered in-band already (answer above came from
    // the tool_result directly) - arrives as its own later message.
    { type: "user_message", content: [{ type: "text", text: `${AUQ_EXTRA_SENTINEL}${LONG_NOTE}` }], timestamp: 0, remote_echo: false },
    { type: "assistant_message", content: [{ type: "text", text: "done" }], streaming: false, timestamp: 0 },
  ];
  return { events, oldest_seq: 0, newest_seq: 0, has_more: false };
}

test("resolved question card with an extra note - collapsed chip and expanded full text", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [sessionInstance()],
      get_active_sessions: [sessionInstance()],
      load_history_page: transcript(),
    },
  });
  await page.locator("#sessions-list li[data-session-id]").first().click();

  const card = page.locator("#session-pane .msg.question-card");
  const details = card.locator(".question-card-collapsible");
  await details.waitFor();

  // Resolved cards default to collapsed - the note shows as a truncated,
  // muted chip alongside the answer chip, no separate bubble anywhere.
  await expect(details).not.toHaveAttribute("open", "");
  await expect(card.locator(".question-card-extra-chip")).toBeVisible();
  await expect(page.locator("#session-pane .msg.user", { hasText: "thinking out loud" })).toHaveCount(0);
  await capture(card, "auq-extra-collapsed");

  // Expanding the card (its own toggle) reveals the full untruncated note.
  await details.locator(".question-card-summary").click();
  await expect(details).toHaveAttribute("open", "");
  const extraText = card.locator(".question-card-extra-text");
  await expect(extraText).toBeVisible();
  await expect(extraText).toContainText("thinking out loud");
  await capture(card, "auq-extra-expanded");
});
