// Hidden chats are one daemon-owned list shared by the desktop app and the
// phone. These pin the client half: a hide/unhide sends only its delta, a
// daemon push is adopted and re-renders, a device's pre-sync local hides are
// merged in once, and a push landing mid-burst never flicks a row back.

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

const { invokeMock, listeners } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listeners: new Map(),
}));

vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
vi.mock("../src/shared/transport.ts", () => ({
  getTransport: () => ({
    listen: async (event, cb) => {
      listeners.set(event, cb);
      return () => listeners.delete(event);
    },
  }),
}));

const helpers = await import("../src/views/sessions/sessions-helpers.ts");
const flush = () => new Promise((r) => setTimeout(r, 0));

async function freshSync() {
  vi.resetModules();
  const sync = await import("../src/views/sessions/hidden-sessions-sync.ts");
  const h = await import("../src/views/sessions/sessions-helpers.ts");
  return { sync, h };
}

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  listeners.clear();
  helpers.setHiddenSessionsPusher(null);
});

describe("saveHiddenSessions", () => {
  it("pushes only what changed, never the whole set", () => {
    const pushes = [];
    helpers.writeHiddenSessionsLocal(new Set(["a", "b"]));
    helpers.setHiddenSessionsPusher((add, remove) => pushes.push({ add, remove }));

    helpers.saveHiddenSessions(new Set(["b", "c"]));

    expect(pushes).toEqual([{ add: ["c"], remove: ["a"] }]);
    expect([...helpers.loadHiddenSessions()].sort()).toEqual(["b", "c"]);
  });

  it("an unchanged set sends nothing", () => {
    const pushes = [];
    helpers.writeHiddenSessionsLocal(new Set(["a"]));
    helpers.setHiddenSessionsPusher((add, remove) => pushes.push({ add, remove }));
    helpers.saveHiddenSessions(new Set(["a"]));
    expect(pushes).toEqual([]);
  });
});

describe("startHiddenSessionsSync", () => {
  it("merges this device's old local-only hides into the daemon list once", async () => {
    localStorage.setItem("cc_hidden_sessions", JSON.stringify(["local-1"]));
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "get_hidden_chats") return { sessions: ["remote-1"] };
      if (cmd === "update_hidden_chats") return { sessions: ["remote-1", ...args.add] };
    });
    const { sync, h } = await freshSync();
    const rerender = vi.fn();

    sync.startHiddenSessionsSync(rerender);
    await flush();

    expect(invokeMock).toHaveBeenCalledWith("update_hidden_chats", { add: ["local-1"], remove: [] });
    expect([...h.loadHiddenSessions()].sort()).toEqual(["local-1", "remote-1"]);
    expect(rerender).toHaveBeenCalled();
    expect(localStorage.getItem("cc_hidden_synced")).toBe("1");
  });

  it("after the one-time merge, the daemon's list wins over the local copy", async () => {
    localStorage.setItem("cc_hidden_synced", "1");
    localStorage.setItem("cc_hidden_sessions", JSON.stringify(["unhidden-elsewhere"]));
    invokeMock.mockResolvedValue({ sessions: [] });
    const { sync, h } = await freshSync();

    sync.startHiddenSessionsSync(() => {});
    await flush();

    expect(invokeMock).not.toHaveBeenCalledWith("update_hidden_chats", expect.anything());
    expect([...h.loadHiddenSessions()]).toEqual([]);
  });

  it("adopts another device's change from the live event", async () => {
    localStorage.setItem("cc_hidden_synced", "1");
    invokeMock.mockResolvedValue({ sessions: [] });
    const { sync, h } = await freshSync();
    const rerender = vi.fn();
    sync.startHiddenSessionsSync(rerender);
    await flush();
    rerender.mockClear();

    listeners.get("hidden-chats-changed")({ sessions: ["from-phone"] });

    expect([...h.loadHiddenSessions()]).toEqual(["from-phone"]);
    expect(rerender).toHaveBeenCalledTimes(1);
  });

  it("a broadcast landing while a local hide is in flight does not undo it", async () => {
    localStorage.setItem("cc_hidden_synced", "1");
    let release;
    let daemon = [];
    invokeMock.mockImplementation((cmd) => {
      if (cmd === "update_hidden_chats") {
        return new Promise((r) => { release = () => { daemon = ["mine"]; r({ sessions: daemon }); }; });
      }
      return Promise.resolve({ sessions: daemon });
    });
    const { sync, h } = await freshSync();
    sync.startHiddenSessionsSync(() => {});
    await flush();
    invokeMock.mockClear();

    h.saveHiddenSessions(new Set(["mine"]));
    // A stale broadcast from before this click arrives first.
    listeners.get("hidden-chats-changed")({ sessions: [] });
    expect([...h.loadHiddenSessions()]).toEqual(["mine"]);

    release();
    await flush();
    await flush();
    expect(invokeMock).toHaveBeenCalledWith("get_hidden_chats");
    expect([...h.loadHiddenSessions()]).toEqual(["mine"]);
  });
});
