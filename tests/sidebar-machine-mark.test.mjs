// @vitest-environment jsdom
//
// Multi-machine federation on the chat heads: a session mirrored in from a paired peer machine
// is told apart by its project face (asks for the peer's icon; no ring is drawn on a head), and the whole head dims
// (`is-machine-offline`) when that peer has gone offline. A locally-hosted chat
// (Instance.machine === null) carries no mark: no mark means "this machine". The machine's name
// is in the hover card ("On <label>"), the project face asks for the peer's own icon, and the
// old phone-only "this daemon's own icon" on a local row has no head equivalent (a head is 44px
// and the phone has no list of rows to tell apart).

import { describe, it, expect, vi, beforeEach } from "vitest";

globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);
if (!globalThis.CSS) globalThis.CSS = window.CSS ?? { escape: (s) => s };

const MACHINES = {
  self: { machine_id: "pc-id", label: "Main_Desktop", os: "windows" },
  peers: [{ machine_id: "mac-id", label: "mac", os: "macos", iroh_id: null, direct_url: null, reverse_device_id: null, added_at: 0, reach: "iroh" }],
};
let machinesResponse = MACHINES;
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn(async (cmd) => (cmd === "list_machines" ? machinesResponse : {})),
}));

let remote = false;
vi.mock("../src/shared/transport.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isRemote: () => remote };
});

const { renderSidebar } = await import("../src/views/sessions/sidebar.ts");
const { state } = await import("../src/views/sessions/state.ts");
const { resetMachineIconsForTests } = await import("../src/views/sessions/machine-icons.ts");

function makeList() {
  const ul = document.createElement("ul");
  ul.id = "sessions-list";
  ul.className = "sessions-list";
  document.body.appendChild(ul);
  return ul;
}

function baseInstance(id, over = {}) {
  return {
    session_id: id,
    pid: 0,
    cwd: "C:/proj",
    project_id: "p",
    kind: "interactive",
    is_remote: false,
    started_at: "2026-06-12T00:00:00Z",
    transcript_path: null,
    name: "Supabase setup",
    ended_at: null,
    end_reason: null,
    busy: false,
    model: "",
    effort: "",
    awaiting: null,
    machine: null,
    ...over,
  };
}

const MAC = { id: "mac-id", label: "mac", online: true };

/** Renders, lets list_machines resolve, and renders again the way the
 *  sidebar's own onChange callback does. */
async function renderSettled(el) {
  renderSidebar(el);
  await vi.advanceTimersByTimeAsync(50);
  // Not runAllTimers: the head tag poll is a setInterval, so it never drains.
  vi.advanceTimersByTime(1000);
}

describe("sidebar machine mark (multi-machine federation)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
    resetMachineIconsForTests();
    machinesResponse = MACHINES;
    remote = false;
    state.sessions = [];
    state.parkedDrafts = [];
    state.filter = "";
    state.selectedId = null;
    state.pendingNewSession = null;
    state.daemonConnected = true;
  });

  it("a mirrored chat gets a project badge that asks for the peer's icon and no ring", async () => {
    const el = makeList();
    state.sessions = [baseInstance("mirrored-1", { machine: MAC })];
    await renderSettled(el);
    const li = el.querySelector('li[data-session-id="mirrored-1"]');
    expect(li.querySelector(".avatar-ring")).toBeNull();
    expect(li.innerHTML).toContain('data-proj-face-machine="mac-id"');
    expect(li.classList.contains("is-machine-offline")).toBe(false);
  });

  it("a local chat has no ring, no machine attribute and no offline class", async () => {
    const el = makeList();
    state.sessions = [baseInstance("local-1"), baseInstance("mirrored-1", { machine: MAC })];
    await renderSettled(el);
    const li = el.querySelector('li[data-session-id="local-1"]');
    expect(li.querySelector(".avatar-ring")).toBeNull();
    expect(li.innerHTML).not.toContain("data-proj-face-machine");
    expect(li.classList.contains("is-machine-offline")).toBe(false);
  });

  it("a mirrored chat whose machine is offline dims", async () => {
    const el = makeList();
    state.sessions = [baseInstance("mirrored-2", { machine: { ...MAC, online: false } })];
    await renderSettled(el);
    expect(el.querySelector('li[data-session-id="mirrored-2"]').classList.contains("is-machine-offline")).toBe(true);
  });

  it("a chat that is asking wears its red number even when it runs on another machine", async () => {
    const el = makeList();
    state.sessions = [baseInstance("mirrored-q", { machine: MAC, awaiting: "question" })];
    await renderSettled(el);
    const li = el.querySelector('li[data-session-id="mirrored-q"]');
    expect(li.querySelector(".avatar-ring")).toBeNull();
    expect(li.querySelector(".chat-head-tag .ht-n.is-red")).not.toBeNull();
  });

  it("no head ever renders a text machine label", async () => {
    remote = true;
    const el = makeList();
    state.sessions = [baseInstance("local-1"), baseInstance("mirrored-1", { machine: MAC })];
    await renderSettled(el);
    expect(el.querySelector(".session-machine-label")).toBeNull();
    expect(el.textContent).not.toContain("Main_Desktop");
  });

  it("an ended mirrored chat still carries its machine identity", async () => {
    const el = makeList();
    state.sessions = [baseInstance("mirrored-3", { machine: MAC, ended_at: "2026-06-12T01:00:00Z" })];
    await renderSettled(el);
    expect(el.innerHTML).toContain('data-proj-face-machine="mac-id"');
  });
});
