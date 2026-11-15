// @vitest-environment jsdom
// asserts: src/views/sessions/sidebar-entries.ts

// The empty chats list tells the user how to start a chat. "Tap +" is only true
// where the sidebar's + button is shown (phone width, session-list.css); on the
// desktop layout it points at nothing, so the hint names the New chat key.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);
if (!globalThis.CSS) globalThis.CSS = window.CSS ?? { escape: (s) => s };

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => ({})) }));

const { renderSidebar } = await import("../src/views/sessions/sidebar.ts");
const { state } = await import("../src/views/sessions/state.ts");

function hintAt(narrow, remote = false) {
  // The desktop webview has the Tauri global; the phone's browser does not.
  if (remote) delete window.__TAURI__; else window.__TAURI__ = {};
  window.matchMedia = vi.fn((q) => ({ matches: narrow && q === "(max-width: 640px)", media: q }));
  const ul = document.createElement("ul");
  ul.id = "sessions-list";
  document.body.appendChild(ul);
  renderSidebar(ul);
  vi.runAllTimers();
  return ul.querySelector(".v-empty-hint").textContent;
}

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  vi.useFakeTimers();
  state.sessions = [];
  state.parkedDrafts = [];
  state.filter = "";
  state.selectedId = null;
  state.pendingNewSession = null;
  state.daemonConnected = true;
});

afterEach(() => {
  vi.useRealTimers();
  delete window.matchMedia;
  delete window.__TAURI__;
});

describe("empty chats list hint", () => {
  it("points at the + button where the phone layout shows it", () => {
    expect(hintAt(true)).toBe("Tap + to start one");
  });

  it("names the New chat key on the desktop layout, where the + button is hidden", () => {
    expect(hintAt(false)).toBe("Press Ctrl+N to start one");
  });

  it("does not name a key on a phone wider than the + layout (a tablet, a landscape phone)", () => {
    expect(hintAt(false, true)).toBe("Start one from a project's dashboard");
  });
});
