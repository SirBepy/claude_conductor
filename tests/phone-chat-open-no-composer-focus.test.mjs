// @vitest-environment jsdom

// Opening a live chat focuses its composer on desktop (so paste lands), but
// never on a phone: in Android WebView a textarea focused from code gets the
// keyboard as a raw key stream (EditorInfo TYPE_NULL), and tapping the
// already-focused box never reconnects it, so Gboard loses voice, swipe and
// suggestions. The draft-pane half is covered by
// e2e/view-harness/new-chat-composer-focus-survives-modal-close.view.spec.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tauriMock } from "./helpers/composer-mount.mjs";

vi.setConfig({ testTimeout: 30000 });

function stubViewport(mobile) {
  window.matchMedia = (query) => ({
    matches: mobile && query === "(max-width: 768px)",
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  });
}

beforeEach(() => {
  localStorage.clear();
  tauriMock(() => undefined);
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
  delete window.matchMedia;
  localStorage.clear();
  vi.restoreAllMocks();
});

async function mountActive() {
  const { resetTransportForTests } = await import("../src/shared/transport.ts");
  resetTransportForTests();
  const { mountComposer } = await import("../src/views/sessions/active-session-composer.ts");
  const pane = document.createElement("div");
  pane.innerHTML = '<div class="session-composer"></div><div class="scheduled-chip-slot"></div>';
  document.body.appendChild(pane);
  mountComposer(pane, { session_id: "sess-1", cwd: "C:\\proj", account_id: null }, "sess-1", false);
  return pane.querySelector(".composer-textarea");
}

describe("opening a live chat", () => {
  it("does not focus the composer on a phone", async () => {
    stubViewport(true);
    const ta = await mountActive();
    expect(ta).toBeTruthy();
    expect(document.activeElement).not.toBe(ta);
  });

  it("still focuses the composer on desktop", async () => {
    stubViewport(false);
    const ta = await mountActive();
    expect(document.activeElement).toBe(ta);
  });
});
