// @vitest-environment jsdom

// A session switch during mountStatusbar's awaits must not publish the older,
// now-detached statusbar: wireRenderer's `state.statusbar === sb` checks would
// then drop the visible session's updates (todo 679).

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn(async () => ({})),
}));

// One gate per loadStatuslineRows call, so an older mount can be resolved
// after a newer one.
const gates = [];
function nextGate() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  const gate = { promise, resolve };
  gates.push(gate);
  return gate;
}

class FakeStatusbar {
  constructor(host) {
    this.host = host;
  }
}

vi.mock("../src/views/sessions/session-statusbar.ts", () => ({
  SessionStatusbar: FakeStatusbar,
  loadStatuslineRows: async () => {
    await nextGate().promise;
    return [];
  },
  loadStatuslineHideZero: async () => false,
}));

const { mountStatusbar } = await import("../src/views/sessions/active-session-mount.ts");
const { state } = await import("../src/views/sessions/state.ts");

function makePane(id) {
  const pane = document.createElement("div");
  pane.dataset.pane = id;
  pane.innerHTML = `<div class="session-statusbar-host"></div>`;
  document.body.appendChild(pane);
  return pane;
}

function makeSession(id) {
  return { session_id: id, kind: "chat", cwd: "/proj", started_at: null, model: null, effort: "" };
}

beforeEach(() => {
  gates.length = 0;
  document.body.innerHTML = "";
  state.statusbar = null;
  state.selectedId = null;
});

describe("mountStatusbar mount guard", () => {
  it("keeps the newer mount's statusbar when an older mount resolves late", async () => {
    state.selectedId = "sess-a";
    const oldMount = mountStatusbar(makePane("a"), makeSession("sess-a"), () => {});

    state.selectedId = "sess-b";
    const newMount = mountStatusbar(makePane("b"), makeSession("sess-b"), () => {});

    gates[1].resolve();
    const newSb = await newMount;
    expect(newSb).toBeInstanceOf(FakeStatusbar);
    expect(state.statusbar).toBe(newSb);

    gates[0].resolve();
    await expect(oldMount).resolves.toBeNull();
    expect(state.statusbar).toBe(newSb);
  });

  it("bails when the view remounted under it", async () => {
    state.selectedId = "sess-a";
    const pending = mountStatusbar(makePane("a"), makeSession("sess-a"), () => {});
    state.mountId += 1;

    gates[0].resolve();
    await expect(pending).resolves.toBeNull();
    expect(state.statusbar).toBeNull();
  });

  it("assigns state.statusbar for an uncontested mount", async () => {
    state.selectedId = "sess-a";
    const pending = mountStatusbar(makePane("a"), makeSession("sess-a"), () => {});
    gates[0].resolve();
    const sb = await pending;
    expect(sb).toBeInstanceOf(FakeStatusbar);
    expect(state.statusbar).toBe(sb);
  });
});
