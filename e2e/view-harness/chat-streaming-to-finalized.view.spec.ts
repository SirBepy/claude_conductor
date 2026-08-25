import { test, expect, type Page } from "@playwright/test";
import { mountView, SESSIONS_BASE_INVOKE, sessionInstance, fireEvent } from "./harness";

// todo 719 repro attempt, at zero billed cost (todo 769): drives a live-turn
// event sequence through the mocked chat:<id> channel (see harness.ts).

const SESSION = sessionInstance();
const CHANNEL = `chat:${SESSION.session_id}`;

function emptyTranscript() {
  return { events: [], oldest_seq: 0, newest_seq: 0, has_more: false };
}

async function mountChat(page: Page): Promise<void> {
  await mountView(page, {
    view: "sessions",
    invoke: {
      ...SESSIONS_BASE_INVOKE,
      list_instances: [SESSION],
      get_active_sessions: [SESSION],
      load_history_page: emptyTranscript(),
    },
  });
  await page.locator(`#sessions-list li[data-session-id="${SESSION.session_id}"]`).click();
  // event-store.ts's loadInitial awaits ensureListener before the pane opens,
  // so polling for the registered channel is the real readiness signal -
  // no arbitrary sleep, no assumption about empty-transcript DOM shape.
  await page.waitForFunction((name) => {
    const w = window as unknown as { __ccListeners?: Map<string, Set<unknown>> };
    return (w.__ccListeners?.get(name)?.size ?? 0) > 0;
  }, CHANNEL);
}

test.describe("view-harness / streaming turn finalizes into a real bubble", () => {
  test("assistant_message(streaming) -> assistant_delta x N -> assistant_message(final)", async ({ page }) => {
    await mountChat(page);

    await fireEvent(page, CHANNEL, [
      { type: "assistant_message", content: [{ type: "text", text: "" }], streaming: true, timestamp: 0 },
      { type: "assistant_delta", text: "Hello", block: 1, seq: 1, snapshot: false, timestamp: 0 },
      { type: "assistant_delta", text: " world", block: 1, seq: 2, snapshot: false, timestamp: 0 },
      { type: "assistant_message", content: [{ type: "text", text: "Hello world" }], streaming: false, timestamp: 0 },
    ]);

    const finalized = page.locator("#session-pane .session-messages .msg.assistant:not(.streaming)");
    await expect(finalized).toHaveCount(1);
    await expect(finalized).toContainText("Hello world");
    await expect(page.locator("#session-pane .session-messages .msg.assistant.streaming")).toHaveCount(0);
  });
});
