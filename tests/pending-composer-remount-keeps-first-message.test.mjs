// @vitest-environment jsdom
// asserts: src/views/sessions/pending-pane-composer.ts

// A draft pane wired by a Sessions mount that has since been replaced must not
// swallow the first message of a new chat. The send used to return quietly on the
// stale mount, so the message reached no chat and no draft. It must land back in
// the draft pane's stored draft instead.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tauriMock } from "./helpers/composer-mount.mjs";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let invokeMock;
let pane;

beforeEach(() => {
  localStorage.clear();
  invokeMock = tauriMock((cmd) =>
    cmd === "get_session_drafts" ? { composer: null, auq: null, held: [], held_updated_at: null } : undefined,
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  pane = document.createElement("div");
  pane.innerHTML = '<div class="session-composer"></div><div class="session-thinking"></div>';
  document.body.appendChild(pane);
});

afterEach(async () => {
  const { state } = await import("../src/views/sessions/state.ts");
  state.composer?.destroy();
  state.composer = null;
  document.body.innerHTML = "";
  delete globalThis.window.__TAURI__;
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("the draft pane's first send after a remount", () => {
  it("restores the typed message as the draft instead of dropping it", async () => {
    const { wirePendingComposer } = await import("../src/views/sessions/pending-pane-composer.ts");
    const { state } = await import("../src/views/sessions/state.ts");
    const { loadDraft } = await import("../src/shared/chat/composer-persistence.ts");

    const staleMount = state.mountId - 1;
    wirePendingComposer(pane, "draft-1", { path: "C:/proj", name: "proj" }, {}, staleMount, {
      rebindPaneHeader: vi.fn(),
      pickAccount: vi.fn(),
    });
    const textarea = pane.querySelector(".composer-textarea");
    textarea.value = "first message of a new chat";
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
    textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(loadDraft("draft-1")).toBe("first message of a new chat"));
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "start_session")).toEqual([]);
  });
});
