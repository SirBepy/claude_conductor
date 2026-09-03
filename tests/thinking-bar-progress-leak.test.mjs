// @vitest-environment jsdom

// The thinking bar's progress/todo labels are module state global to the pane.
// Switching chats used to leave the previous chat's "Step 1 of 6" on every
// other chat's bar, because those fields only cleared on an activity-to-null
// push that a busy chat never sends.

import { describe, it, expect, beforeEach } from "vitest";

const {
  initThinkingBar,
  setThinkingActivity,
  setThinkingProgress,
  setThinkingTodoActivity,
  syncThinkingBar,
} = await import("../src/views/sessions/session-thinking-bar.ts");
const { state } = await import("../src/views/sessions/state.ts");

function makePane() {
  const pane = document.createElement("div");
  pane.innerHTML = `<div class="session-thinking" hidden><span class="thinking-text"></span></div>`;
  initThinkingBar(pane);
  return pane;
}

function barText(pane) {
  return pane.querySelector(".thinking-text").textContent;
}

/** Both chats are busy - the leak only shows while the bar is visible. */
function selectBusy(id) {
  state.selectedId = id;
  state.sessions = [
    { session_id: "chat-a", busy: true },
    { session_id: "chat-b", busy: true },
  ];
}

describe("thinking bar per-chat progress", () => {
  let pane;

  beforeEach(() => {
    state.pendingNewSession = null;
    state.heldMessages = null;
    pane = makePane();
    selectBusy("chat-a");
    setThinkingActivity(null);
  });

  it("does not carry one chat's progress onto another chat", () => {
    setThinkingActivity("Reading state.ts");
    setThinkingProgress(1, 6);
    expect(barText(pane)).toBe("Step 1 of 6");

    // Switch to a chat that is busy but has emitted no progress marker.
    selectBusy("chat-b");
    syncThinkingBar({
      lastActivity: "Editing api.ts",
      activityIdle: false,
      lastProgress: null,
      lastTodoActivity: null,
    });

    expect(barText(pane)).toBe("Editing api.ts");
  });

  it("does not carry one chat's todo label onto another chat", () => {
    setThinkingActivity("Reading state.ts");
    setThinkingTodoActivity("Wiring the daemon");
    expect(barText(pane)).toBe("Wiring the daemon");

    selectBusy("chat-b");
    syncThinkingBar({
      lastActivity: null,
      activityIdle: false,
      lastProgress: null,
      lastTodoActivity: null,
    });

    expect(barText(pane)).toBe("Thinking…");
  });

  it("restores the switched-to chat's own progress", () => {
    setThinkingActivity("Reading state.ts");
    setThinkingProgress(1, 6);

    selectBusy("chat-b");
    syncThinkingBar({
      lastActivity: "Editing api.ts",
      activityIdle: false,
      lastProgress: { n: 3, m: 4 },
      lastTodoActivity: null,
    });

    expect(barText(pane)).toBe("Step 3 of 4");
  });
});
