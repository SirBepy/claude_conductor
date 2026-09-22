// @vitest-environment jsdom
//
// Regression for the "my chat vanished after a rebuild and I had to dig it out
// of History" bug. A `cargo tauri dev` rebuild (or daemon crash / app update)
// restarts the app; the session list is transiently empty, which fires
// setActiveSession(null) to clear the pane. That used to ALSO erase the
// persisted last-viewed chat id, so the restore-on-reconnect found nothing and
// the user landed on a blank app. The persisted id must survive a transient
// deselect and only be cleared by an explicit close.
//
// The id serves in-run recovery only. A cold launch must NOT reopen it: doing
// so froze the window whenever the last chat was a huge transcript.

import { describe, it, expect, beforeEach, vi } from "vitest";

if (!globalThis.CSS) globalThis.CSS = window.CSS ?? { escape: (s) => s };
vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => ({})) }));

const { setActiveSession, loadLastSelectedSession, clearLastSelectedSession } =
  await import("../src/views/sessions/state.ts");

beforeEach(() => {
  localStorage.clear();
});

describe("last-selected chat persistence (survives an app restart)", () => {
  it("persists the selected chat id", () => {
    setActiveSession("chat-1");
    expect(loadLastSelectedSession()).toBe("chat-1");
  });

  it("a transient deselect does NOT erase it (regression: blank app after rebuild)", () => {
    setActiveSession("chat-1");
    setActiveSession(null); // daemon restart empties the list -> pane clear
    expect(loadLastSelectedSession()).toBe("chat-1"); // still restorable on reconnect
  });

  it("an explicit close forgets it", () => {
    setActiveSession("chat-1");
    clearLastSelectedSession();
    expect(loadLastSelectedSession()).toBeNull();
  });

  it("does not persist pending placeholder ids, and leaves a real id intact", () => {
    setActiveSession("chat-1");
    setActiveSession("pending-abc");
    expect(loadLastSelectedSession()).toBe("chat-1");
  });

  it("a cold launch does not offer the stored id (no chat auto-opens on boot)", async () => {
    localStorage.setItem("cc_last_selected_session", "chat-1");
    vi.resetModules();
    const fresh = await import("../src/views/sessions/state.ts");
    expect(fresh.loadLastSelectedSession()).toBeNull();
    fresh.setActiveSession("chat-2");
    expect(fresh.loadLastSelectedSession()).toBe("chat-2");
  });
});
