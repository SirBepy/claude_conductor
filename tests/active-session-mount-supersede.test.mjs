// @vitest-environment jsdom

// asserts: src/views/sessions/active-session-mount.ts
//
// Two small guards in active-session-mount.ts:
// - a mount superseded while its load hangs forever never reaches settleLoad(),
//   so the 8s stall banner has to leave on its own;
// - the "chat-open statusbar-settings" perf phase closes even when a settings
//   read rejects, else the longtask attribution names a phase that is long over.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => ({})) }));

const phaseDone = vi.fn();
vi.mock("../src/shared/perf.ts", () => ({
  perfPhase: (label) => {
    if (label === "chat-open statusbar-settings") return phaseDone;
    return () => {};
  },
}));

const settings = {
  rows: async () => [],
  hideZero: async () => false,
};
vi.mock("../src/views/sessions/session-statusbar.ts", () => ({
  SessionStatusbar: class {},
  loadStatuslineRows: () => settings.rows(),
  loadStatuslineHideZero: () => settings.hideZero(),
}));

// loadFromStore never settles: the wedged local read the stall guard exists for.
vi.mock("../src/shared/chat/chat-renderer.ts", () => ({
  ChatRenderer: class {
    constructor() {
      this.messages = [];
      this.messageEls = new Map();
      this.paginator = {};
      this.toolTally = {};
    }
    async attach() {}
    detach() {}
    getMeta() { return {}; }
    customToolView() { return null; }
    loadFromStore() { return new Promise(() => {}); }
  },
}));
vi.mock("../src/shared/chat/event-store.ts", () => ({
  sessionEvents: { isLoaded: () => true, reconcileLatest: async () => {} },
}));
vi.mock("../src/shared/chat/chat-loading.ts", () => ({
  mountChatLoadingOverlay: () => ({ remove() {} }),
}));
vi.mock("../src/views/sessions/chat-pane-cache.ts", () => ({
  takeRetainedChat: () => null,
  retainChat: () => {},
  isRetainedRenderer: () => false,
}));
vi.mock("../src/views/sessions/sidebar.ts", () => ({ renderSidebar: () => {} }));
vi.mock("../src/views/sessions/code-mode/entry.ts", () => ({
  setCodeModeChatProvider: () => {},
  enterCodeMode: async () => {},
}));
vi.mock("../src/views/sessions/code-mode/code-mode.ts", () => ({
  closeCodeMode: () => {},
  currentCodeModeKey: () => null,
}));
vi.mock("../src/views/sessions/session-thinking-bar.ts", () => ({
  noteThinkingEvent: () => {},
  setThinkingActivity: () => {},
  setThinkingProgress: () => {},
  setThinkingTodoActivity: () => {},
  syncThinkingBar: () => {},
}));

const { mountRenderer, mountStatusbar } = await import("../src/views/sessions/active-session-mount.ts");
const { state } = await import("../src/views/sessions/state.ts");

function makePane() {
  const pane = document.createElement("div");
  pane.innerHTML = `<div class="session-statusbar-host"></div><div class="session-messages"></div>`;
  document.body.appendChild(pane);
  return pane;
}

const session = { session_id: "sess-a", kind: "chat", cwd: "/proj", started_at: null, model: null, effort: "" };

beforeEach(() => {
  document.body.innerHTML = "";
  state.renderer = null;
  state.statusbar = null;
  state.selectedId = "sess-a";
  phaseDone.mockClear();
  settings.rows = async () => [];
  settings.hideZero = async () => false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mountRenderer stall banner", () => {
  it("removes the banner when the mount is superseded while the load still hangs", async () => {
    vi.useFakeTimers();
    const pane = makePane();
    const header = { el: document.createElement("div") };
    void mountRenderer(pane, session, header, "sess-a", state.mountId, () => {});
    await vi.advanceTimersByTimeAsync(8100);
    expect(pane.querySelector(".chat-load-stalled")).not.toBeNull();

    // A newer selectSession lands; this load never settles, so only the banner
    // watching for it can take the banner down.
    state.selectedId = "sess-b";
    await vi.advanceTimersByTimeAsync(2000);
    expect(pane.querySelector(".chat-load-stalled")).toBeNull();
  });

  it("keeps the banner while the mount is still the visible one", async () => {
    vi.useFakeTimers();
    const pane = makePane();
    const header = { el: document.createElement("div") };
    void mountRenderer(pane, session, header, "sess-a", state.mountId, () => {});
    await vi.advanceTimersByTimeAsync(12000);
    expect(pane.querySelector(".chat-load-stalled")).not.toBeNull();
  });
});

describe("mountStatusbar settings read", () => {
  it("closes the settings perf phase when a settings read rejects, and still rejects", async () => {
    settings.rows = async () => { throw new Error("settings read failed"); };
    const pane = makePane();
    await expect(mountStatusbar(pane, session, () => {})).rejects.toThrow("settings read failed");
    expect(phaseDone).toHaveBeenCalledTimes(1);
  });

  it("closes the settings perf phase once on the normal path", async () => {
    const pane = makePane();
    await mountStatusbar(pane, session, () => {});
    expect(phaseDone).toHaveBeenCalledTimes(1);
  });
});
