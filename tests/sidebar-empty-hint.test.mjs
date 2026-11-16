// @vitest-environment jsdom
// asserts: src/views/sessions/chat-heads.ts

// With no chats the stack is a toggle and a + head. The + head's name tells the user how to
// start a chat: the desktop names the New chat key, a phone (no keyboard) just says New chat.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);
if (!globalThis.CSS) globalThis.CSS = window.CSS ?? { escape: (s) => s };

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => ({})) }));

const { renderSidebar } = await import("../src/views/sessions/sidebar.ts");
const { state } = await import("../src/views/sessions/state.ts");

function plusLabel(remote = false) {
  // The desktop webview has the Tauri global; the phone's browser does not.
  if (remote) delete window.__TAURI__; else window.__TAURI__ = {};
  const ul = document.createElement("ul");
  ul.id = "sessions-list";
  document.body.appendChild(ul);
  renderSidebar(ul);
  vi.runAllTimers();
  return ul.querySelector("li[data-heads-new]").getAttribute("title");
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

describe("the + head's name", () => {
  it("names the New chat key on the desktop", () => {
    expect(plusLabel(false)).toBe("New chat (Ctrl+N)");
  });

  it("says just New chat on the phone, which has no key to press", () => {
    expect(plusLabel(true)).toBe("New chat");
  });
});
