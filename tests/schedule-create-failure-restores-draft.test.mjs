// @vitest-environment jsdom

// Red->green regression: both panes' onSchedule used to fire schedule_create
// without awaiting it, so a daemon-side rejection never reached the composer's
// restoreDraft catch. The composer had already cleared the draft, so the typed
// text was lost and (on the rate-limit path) a "Scheduled for ..." notice still
// showed. onSchedule must reject so the draft comes back and no notice shows.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tauriMock } from "./helpers/composer-mount.mjs";

vi.setConfig({ testTimeout: 30000 });

let invoke;
let scheduleResult;

beforeEach(() => {
  localStorage.clear();
  scheduleResult = "reject";
  invoke = tauriMock((cmd) => {
    if (cmd === "schedule_create") {
      if (scheduleResult === "reject") throw new Error("daemon said no");
      return { fire_at: "2030-01-01T10:00:00Z" };
    }
    return undefined;
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  const { state } = await import("../src/views/sessions/state.ts");
  state.composer?.destroy();
  state.composer = null;
  state.scheduledChip?.destroy();
  state.scheduledChip = null;
  state.sessions = [];
  document.body.innerHTML = "";
  delete globalThis.window.__TAURI__;
  localStorage.clear();
  vi.restoreAllMocks();
});

const scheduleCalls = () => invoke.mock.calls.filter(([c]) => c === "schedule_create");

function scheduleViaMenu(root, textarea, text) {
  textarea.value = text;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  root.querySelector(".composer-send-chevron").click();
  const row = [...document.querySelectorAll(".composer-menu-popover [data-idx]")].find((b) =>
    b.textContent.includes("Schedule message"),
  );
  expect(row).toBeTruthy();
  row.click();
  const preset = document.querySelector(".schedule-picker-popover [data-preset]");
  expect(preset).toBeTruthy();
  preset.click();
}

async function mountPending() {
  const { resetTransportForTests } = await import("../src/shared/transport.ts");
  resetTransportForTests();
  const { wirePendingComposer } = await import("../src/views/sessions/pending-pane-composer.ts");
  const { state } = await import("../src/views/sessions/state.ts");
  const pane = document.createElement("div");
  pane.innerHTML = '<div class="session-composer"></div>';
  document.body.appendChild(pane);
  // accountId set so the pane's account gates pass and the call reaches schedule_create.
  wirePendingComposer(
    pane,
    "pending-1-ab",
    { path: "C:\\proj", name: "proj" },
    { model: "opus", effort: "high", accountId: "acc-1" },
    state.mountId,
    { rebindPaneHeader: () => {}, pickAccount: () => {} },
  );
  return { root: pane, textarea: pane.querySelector(".composer-textarea"), state };
}

async function mountActive(blocked) {
  const { resetTransportForTests } = await import("../src/shared/transport.ts");
  resetTransportForTests();
  const { mountComposer } = await import("../src/views/sessions/active-session-composer.ts");
  const { state } = await import("../src/views/sessions/state.ts");
  const sess = { session_id: "sess-1", cwd: "C:\\proj", account_id: null };
  if (blocked) {
    state.sessions = [
      { ...sess, rate_limited_resets_at: BigInt(Math.floor(Date.now() / 1000) + 3600) },
    ];
  }
  const pane = document.createElement("div");
  pane.innerHTML = '<div class="session-composer"></div><div class="scheduled-chip-slot"></div>';
  document.body.appendChild(pane);
  mountComposer(pane, sess, "sess-1", false);
  return { root: pane, textarea: pane.querySelector(".composer-textarea"), state };
}

describe("draft pane: schedule_create rejects", () => {
  it("puts the text back and shows no scheduled notice", async () => {
    const { root, textarea } = await mountPending();
    scheduleViaMenu(root, textarea, "remember the milk");

    await vi.waitFor(() => expect(scheduleCalls()).toHaveLength(1));
    await vi.waitFor(() => expect(textarea.value).toBe("remember the milk"));
    expect(root.querySelector(".composer-notice").hidden).toBe(true);
  });

  it("clears the box when schedule_create succeeds", async () => {
    scheduleResult = "ok";
    const { root, textarea } = await mountPending();
    scheduleViaMenu(root, textarea, "remember the milk");

    await vi.waitFor(() => expect(scheduleCalls()).toHaveLength(1));
    // Let the awaited call settle before asserting nothing was restored.
    await new Promise((r) => setTimeout(r, 20));
    expect(textarea.value).toBe("");
  });
});

describe("live chat: schedule_create rejects", () => {
  it("puts the text back from the chevron menu", async () => {
    const { root, textarea } = await mountActive(false);
    scheduleViaMenu(root, textarea, "remember the milk");

    await vi.waitFor(() => expect(scheduleCalls()).toHaveLength(1));
    await vi.waitFor(() => expect(textarea.value).toBe("remember the milk"));
    expect(root.querySelector(".composer-notice").hidden).toBe(true);
  });

  it("puts the text back and shows no notice on the rate-limit auto-schedule", async () => {
    const { root, textarea } = await mountActive(true);
    textarea.value = "remember the milk";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(scheduleCalls()).toHaveLength(1));
    await vi.waitFor(() => expect(textarea.value).toBe("remember the milk"));
    expect(root.querySelector(".composer-notice").hidden).toBe(true);
  });

  it("clears the box when schedule_create succeeds", async () => {
    scheduleResult = "ok";
    const { root, textarea } = await mountActive(false);
    scheduleViaMenu(root, textarea, "remember the milk");

    await vi.waitFor(() => expect(scheduleCalls()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(textarea.value).toBe("");
  });
});
