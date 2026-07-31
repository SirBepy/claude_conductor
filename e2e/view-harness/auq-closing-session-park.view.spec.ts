import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// Regression: since commit a3ef1d1a made the `closing` flag a daemon-registry
// broadcast to EVERY window, isForSelectedSession's old bypass
// (`state.sessions.some(s => s.session_id === eventSessionId && s.closing)`)
// admitted a card for ANY session running /close into whichever chat's pane
// happened to be on screen. Fixed by removing the bypass (gating.ts) so a
// closing session's prompt parks and replays exactly like any other
// non-selected session's prompt.
//
// Drives the real production wiring - handleQuestionRequested (exported from
// permission-modal/index.ts for this purpose), isForSelectedSession,
// ensureHost, storePendingPrompt, replayPendingPrompt - directly, rather than
// a full sidebar-click session switch: fully mounting a second session pane
// goes through active-session-mount.ts (owned by a concurrent session/FORBIDDEN
// here) and needs a daemon-shaped Instance + many more invoke mocks than this
// bug needs to reproduce. Session state is set directly instead.

declare global {
  interface Window {
    __questionModule?: typeof import("/views/sessions/permission-modal/index.ts");
    __stateModule?: typeof import("/views/sessions/state.ts");
  }
}

test.describe("view-harness / closing session's AUQ card does not bleed into the selected pane", () => {
  test("session A (closing) gets no card over session B's (selected) pane; A's card replays after switching to A", async ({ page }) => {
    await mountView(page);

    await page.evaluate(async () => {
      const qm = await import("/views/sessions/permission-modal/index.ts");
      const sm = await import("/views/sessions/state.ts");
      window.__questionModule = qm;
      window.__stateModule = sm;

      // Session B is selected; session A is mid-/close (daemon-broadcast flag).
      sm.state.sessions = [
        { session_id: "sess-A", closing: true },
        { session_id: "sess-B", closing: false },
      ] as unknown as typeof sm.state.sessions;
      sm.state.selectedId = "sess-B";
      qm.setSelectedSessionId("sess-B");

      // Only B's pane/composer exists, exactly as in the real app (one pane
      // mounted at a time).
      const paneB = document.createElement("div");
      paneB.id = "pane-B";
      paneB.innerHTML = '<div class="session-composer"></div>';
      document.body.appendChild(paneB);

      // A's question-requested event arrives while B is on screen.
      qm.handleQuestionRequested({
        id: "q-a-1",
        session_id: "sess-A",
        questions: [{ question: "Proceed with the closing session's step?", options: [{ label: "Yes" }, { label: "No" }] }],
      });
    });

    // The bug: this card used to mount right here, over B's composer.
    await expect(page.locator(".prompt-card")).toHaveCount(0);

    const parked = await page.evaluate(() => window.__questionModule!.pendingPromptSessionIds().has("sess-A"));
    expect(parked).toBe(true);

    // Switch to session A: swap the pane, update selection, replay.
    await page.evaluate(async () => {
      const qm = window.__questionModule!;
      const sm = window.__stateModule!;
      document.getElementById("pane-B")?.remove();
      const paneA = document.createElement("div");
      paneA.id = "pane-A";
      paneA.innerHTML = '<div class="session-composer"></div>';
      document.body.appendChild(paneA);

      sm.state.selectedId = "sess-A";
      qm.setSelectedSessionId("sess-A");
      qm.replayPendingPrompt("sess-A");
    });

    const card = page.locator(".prompt-card");
    await expect(card).toHaveCount(1);
    await expect(page.locator("#pane-A .prompt-card")).toHaveCount(1);

    // showQuestionCard re-parks while it's on screen (so a further switch-away
    // and back still re-surfaces it) - re-parking here is correct, not a leak.
    const reparkedWhileShown = await page.evaluate(() => window.__questionModule!.pendingPromptSessionIds().has("sess-A"));
    expect(reparkedWhileShown).toBe(true);
  });
});
