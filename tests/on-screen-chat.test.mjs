import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The Android shell skips and clears banners for the chat on screen, so the SPA
// must report it only while the Chats view shows, and "" otherwise.

const { noteView, noteSelectedChat, _resetOnScreenChatForTest } = await import("../src/shared/on-screen-chat.ts");

describe("on-screen chat reporting", () => {
  let setOnScreenChat;

  beforeEach(() => {
    _resetOnScreenChatForTest();
    setOnScreenChat = vi.fn();
    globalThis.window = { ConductorPush: { setOnScreenChat } };
  });

  afterEach(() => {
    delete globalThis.window;
  });

  it("reports the selected chat while the Chats view shows", () => {
    noteView("sessions");
    noteSelectedChat("c1");
    expect(setOnScreenChat).toHaveBeenLastCalledWith("c1");
  });

  it("reports no chat on another view, and the chat again on return", () => {
    noteView("sessions");
    noteSelectedChat("c1");
    noteView("settings-notifications");
    expect(setOnScreenChat).toHaveBeenLastCalledWith("");
    noteView("sessions");
    expect(setOnScreenChat).toHaveBeenLastCalledWith("c1");
  });

  it("reports no chat once the selection clears", () => {
    noteView("sessions");
    noteSelectedChat("c1");
    noteSelectedChat(null);
    expect(setOnScreenChat).toHaveBeenLastCalledWith("");
  });

  it("does not repeat an unchanged report", () => {
    noteView("sessions");
    noteSelectedChat("c1");
    noteSelectedChat("c1");
    noteView("sessions");
    expect(setOnScreenChat.mock.calls.filter(([id]) => id === "c1")).toHaveLength(1);
  });

  it("is a no-op without the bridge method (desktop, browser, older shell)", () => {
    globalThis.window = { ConductorPush: {} };
    expect(() => {
      noteView("sessions");
      noteSelectedChat("c1");
    }).not.toThrow();
  });
});
