// @vitest-environment jsdom
//
// Multi-machine federation (H2): a session mirrored in from a paired peer
// machine gets a small `.session-machine-badge` glyph next to the project
// name, and the whole row dims (`is-machine-offline`) when that peer has
// gone offline. A locally-hosted row (Instance.machine === null) gets
// neither - this is the regression a stray `machine: undefined` read would
// silently pass (badge always "", never asserted false).

import { describe, it, expect, vi, beforeEach } from "vitest";

globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);
if (!globalThis.CSS) globalThis.CSS = window.CSS ?? { escape: (s) => s };

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => ({})) }));

const { renderSidebar } = await import("../src/views/sessions/sidebar.ts");
const { state } = await import("../src/views/sessions/state.ts");

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
    name: null,
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

describe("sidebar machine mark (multi-machine federation)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
    state.sessions = [];
    state.parkedDrafts = [];
    state.filter = "";
    state.selectedId = null;
    state.pendingNewSession = null;
    state.daemonConnected = true;
  });

  it("a local row (machine: null) has no machine badge or offline class", () => {
    const el = makeList();
    state.sessions = [baseInstance("local-1", { machine: null })];
    renderSidebar(el);
    vi.runAllTimers();
    const li = el.querySelector('li[data-session-id="local-1"]');
    expect(li).not.toBeNull();
    expect(li.querySelector(".session-machine-badge")).toBeNull();
    expect(li.classList.contains("is-machine-offline")).toBe(false);
  });

  it("a mirrored online row shows the glyph with an 'On <label>' tip", () => {
    const el = makeList();
    state.sessions = [
      baseInstance("mirrored-1", { machine: { id: "m1", label: "Mac Mini", online: true } }),
    ];
    renderSidebar(el);
    vi.runAllTimers();
    const li = el.querySelector('li[data-session-id="mirrored-1"]');
    const badge = li.querySelector(".session-machine-badge");
    expect(badge).not.toBeNull();
    expect(badge.classList.contains("session-machine-badge--offline")).toBe(false);
    expect(badge.getAttribute("data-tip")).toBe("On Mac Mini");
    expect(li.classList.contains("is-machine-offline")).toBe(false);
  });

  it("a mirrored offline row gets the --offline glyph and is-machine-offline", () => {
    const el = makeList();
    state.sessions = [
      baseInstance("mirrored-2", { machine: { id: "m2", label: "Mac Mini", online: false } }),
    ];
    renderSidebar(el);
    vi.runAllTimers();
    const li = el.querySelector('li[data-session-id="mirrored-2"]');
    const badge = li.querySelector(".session-machine-badge");
    expect(badge).not.toBeNull();
    expect(badge.classList.contains("session-machine-badge--offline")).toBe(true);
    expect(badge.getAttribute("data-tip")).toBe("On Mac Mini (offline)");
    expect(li.classList.contains("is-machine-offline")).toBe(true);
  });

  it("shows the glyph on an ended row too (identity, not status)", () => {
    const el = makeList();
    state.sessions = [
      baseInstance("mirrored-3", {
        machine: { id: "m3", label: "Mac Mini", online: true },
        ended_at: "2026-06-12T01:00:00Z",
      }),
    ];
    renderSidebar(el);
    vi.runAllTimers();
    // Ended rows may land in a collapsed "Hidden"/history segment depending on
    // sidebar-entries' grouping - the assertion is on the badge markup itself,
    // not on visibility, so query the whole list rather than one li.
    expect(el.innerHTML).toContain("session-machine-badge");
  });
});
