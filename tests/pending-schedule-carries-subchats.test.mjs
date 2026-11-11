// @vitest-environment jsdom

// A new chat scheduled from a draft must carry the draft's Use subchats switch
// in the `new_chat` kind, or the fired chat starts as an ordinary one.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tauriMock } from "./helpers/composer-mount.mjs";

vi.setConfig({ testTimeout: 30000 });

let invoke;

beforeEach(() => {
  localStorage.clear();
  invoke = tauriMock((cmd) => (cmd === "schedule_create" ? { fire_at: "2030-01-01T10:00:00Z" } : undefined));
});

afterEach(async () => {
  const { state } = await import("../src/views/sessions/state.ts");
  state.composer?.destroy();
  state.composer = null;
  state.scheduledChip?.destroy();
  state.scheduledChip = null;
  document.body.innerHTML = "";
  delete globalThis.window.__TAURI__;
  localStorage.clear();
  vi.restoreAllMocks();
});

function scheduleViaMenu(root, textarea, text) {
  textarea.value = text;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  root.querySelector(".composer-send").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const row = [...document.querySelectorAll(".composer-menu-popover [data-idx]")].find((b) =>
    b.textContent.includes("Schedule message"),
  );
  row.click();
  document.querySelector(".schedule-picker-popover [data-preset]").click();
}

async function scheduledKind(config) {
  const { resetTransportForTests } = await import("../src/shared/transport.ts");
  resetTransportForTests();
  const { wirePendingComposer } = await import("../src/views/sessions/pending-pane-composer.ts");
  const { state } = await import("../src/views/sessions/state.ts");
  const pane = document.createElement("div");
  pane.innerHTML = '<div class="session-composer"></div>';
  document.body.appendChild(pane);
  wirePendingComposer(
    pane,
    "pending-1-ab",
    { path: "C:\\proj", name: "proj" },
    { model: "opus", effort: "high", accountId: "acc-1", ...config },
    state.mountId,
    { rebindPaneHeader: () => {}, pickAccount: () => {} },
  );
  scheduleViaMenu(pane, pane.querySelector(".composer-textarea"), "run the sweep");
  await vi.waitFor(() => expect(invoke.mock.calls.some(([c]) => c === "schedule_create")).toBe(true));
  return invoke.mock.calls.find(([c]) => c === "schedule_create")[1].kind;
}

describe("draft pane: scheduling a new chat", () => {
  it("carries the Use subchats switch when it is on", async () => {
    expect((await scheduledKind({ subchatsOn: true })).subchats_on).toBe(true);
  });

  it("sends false when the switch is off or was never touched", async () => {
    expect((await scheduledKind({})).subchats_on).toBe(false);
  });
});
