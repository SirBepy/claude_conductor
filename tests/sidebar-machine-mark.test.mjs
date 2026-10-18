// @vitest-environment jsdom
//
// Multi-machine federation: a session mirrored in from a paired peer machine
// carries that machine's icon after the project name, and the whole row dims
// (`is-machine-offline`) when that peer has gone offline. On desktop a
// locally-hosted row (Instance.machine === null) carries no mark - no mark
// means "this machine". On the phone, which is none of the machines, local
// rows carry this daemon's own icon once a peer is paired.

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
    bridge_session_id: null,
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
  vi.runAllTimers();
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

  it("a titled row is two lines: title over project, the machine icon after the project", async () => {
    const el = makeList();
    state.sessions = [baseInstance("mirrored-1", { machine: MAC })];
    await renderSettled(el);
    const li = el.querySelector('li[data-session-id="mirrored-1"]');
    expect(li.querySelector(".session-row-text.is-two-line")).not.toBeNull();
    expect(li.querySelector(".session-row-title-text").textContent).toBe("Supabase setup");
    const project = li.querySelector(".session-row-project");
    expect(project.querySelector(".proj-name").textContent).toBe("proj");
    expect(project.querySelector(".session-machine-badge")).not.toBeNull();
  });

  it("desktop: a local row has no machine badge or offline class", async () => {
    const el = makeList();
    state.sessions = [baseInstance("local-1"), baseInstance("mirrored-1", { machine: MAC })];
    await renderSettled(el);
    const li = el.querySelector('li[data-session-id="local-1"]');
    expect(li.querySelector(".session-machine-badge")).toBeNull();
    expect(li.classList.contains("is-machine-offline")).toBe(false);
  });

  it("a mirrored Mac row gets the Apple logo with an 'On <label>' tip", async () => {
    const el = makeList();
    state.sessions = [baseInstance("mirrored-1", { machine: MAC })];
    await renderSettled(el);
    const badge = el.querySelector('li[data-session-id="mirrored-1"] .session-machine-badge');
    expect(badge.classList.contains("ph-apple-logo")).toBe(true);
    expect(badge.classList.contains("session-machine-badge--offline")).toBe(false);
    expect(badge.getAttribute("data-tip")).toBe("On mac");
  });

  it("a mirrored row keeps the generic glyph when list_machines is unavailable", async () => {
    machinesResponse = {};
    const el = makeList();
    state.sessions = [baseInstance("mirrored-1", { machine: MAC })];
    await renderSettled(el);
    const badge = el.querySelector('li[data-session-id="mirrored-1"] .session-machine-badge');
    expect(badge.classList.contains("ph-desktop")).toBe(true);
  });

  it("a mirrored offline row gets the --offline glyph and is-machine-offline", async () => {
    const el = makeList();
    state.sessions = [baseInstance("mirrored-2", { machine: { ...MAC, online: false } })];
    await renderSettled(el);
    const li = el.querySelector('li[data-session-id="mirrored-2"]');
    const badge = li.querySelector(".session-machine-badge");
    expect(badge.classList.contains("session-machine-badge--offline")).toBe(true);
    expect(badge.getAttribute("data-tip")).toBe("On mac (offline)");
    expect(li.classList.contains("is-machine-offline")).toBe(true);
  });

  it("phone: a local row carries this daemon's own icon once a peer is paired", async () => {
    remote = true;
    const el = makeList();
    state.sessions = [baseInstance("local-1"), baseInstance("mirrored-1", { machine: MAC })];
    await renderSettled(el);
    const badge = el.querySelector('li[data-session-id="local-1"] .session-machine-badge');
    expect(badge).not.toBeNull();
    expect(badge.classList.contains("ph-windows-logo")).toBe(true);
    expect(badge.getAttribute("data-tip")).toBe("On Main_Desktop");
  });

  it("phone: no peer paired, so local rows stay unmarked", async () => {
    remote = true;
    machinesResponse = { self: MACHINES.self, peers: [] };
    const el = makeList();
    state.sessions = [baseInstance("local-1")];
    await renderSettled(el);
    expect(el.querySelector('li[data-session-id="local-1"] .session-machine-badge')).toBeNull();
  });

  it("no row ever renders a text machine label", async () => {
    remote = true;
    const el = makeList();
    state.sessions = [baseInstance("local-1"), baseInstance("mirrored-1", { machine: MAC })];
    await renderSettled(el);
    expect(el.querySelector(".session-machine-label")).toBeNull();
    expect(el.textContent).not.toContain("Main_Desktop");
  });

  it("shows the glyph on an ended row too (identity, not status)", async () => {
    const el = makeList();
    state.sessions = [
      baseInstance("mirrored-3", { machine: MAC, ended_at: "2026-06-12T01:00:00Z" }),
    ];
    await renderSettled(el);
    // Ended rows may land in a collapsed "Hidden"/history segment depending on
    // sidebar-entries' grouping - the assertion is on the badge markup itself,
    // not on visibility, so query the whole list rather than one li.
    expect(el.innerHTML).toContain("session-machine-badge");
  });
});
