// @vitest-environment jsdom
//
// Regression for: "Ctrl+Num can't jump into a draft chat" - buildSidebarEntries
// never gave a draft/parked row a data-kbd-hint badge or a slot in
// state.sortedSessionIds, so the Ctrl+1..9 index array only ever contained
// real backend session ids. This drives the real renderSidebar (not a stub)
// so a regression in the draft-numbering order is caught.

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

function draftState(placeholderId) {
  return {
    placeholderId,
    projectPath: "/proj",
    projectName: "Proj",
    config: { model: "opus", effort: "high" },
    realId: null,
    firstMessageSent: false,
    preExistingSessionIds: new Set(),
    firstMessageSentAt: null,
  };
}

function realSession(id) {
  // A different cwd than the draft's "/proj": sidebar-entries.ts's
  // pre-resolution filter hides a same-cwd newcomer row (see its
  // "pendingRealId" comment) - unrelated to the numbering this test covers.
  return { session_id: id, cwd: "/other-proj", model: "opus", kind: "interactive", busy: false };
}

describe("Ctrl+Num numbering includes draft/parked rows", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
    state.sessions = [];
    state.parkedDrafts = [];
    state.filter = "";
    state.selectedId = null;
    state.pendingNewSession = null;
    state.sortedSessionIds = [];
    localStorage.clear();
  });

  it("numbers the unsent draft ahead of real sessions and records it in sortedSessionIds", () => {
    const el = makeList();
    state.pendingNewSession = draftState("pending-1");
    state.sessions = [realSession("real-1")];

    renderSidebar(el);
    vi.runAllTimers();

    const draftLi = el.querySelector('li[data-placeholder-id="pending-1"]');
    expect(draftLi?.getAttribute("data-kbd-hint")).toBe("1");
    expect(state.sortedSessionIds[0]).toBe("pending-1");
    expect(state.sortedSessionIds).toContain("real-1");
    expect(state.sortedSessionIds.indexOf("pending-1")).toBeLessThan(state.sortedSessionIds.indexOf("real-1"));
  });

  it("numbers a parked draft too, after the active draft", () => {
    const el = makeList();
    state.pendingNewSession = draftState("pending-1");
    state.parkedDrafts = [
      { placeholderId: "parked-1", projectPath: "/proj2", projectName: "Proj2", config: { model: "opus", effort: "high" } },
    ];

    renderSidebar(el);
    vi.runAllTimers();

    const parkedLi = el.querySelector('li[data-placeholder-id="parked-1"]');
    expect(parkedLi?.getAttribute("data-kbd-hint")).toBe("2");
    expect(state.sortedSessionIds.slice(0, 2)).toEqual(["pending-1", "parked-1"]);
  });

  it("gives draft rows no kbd hint in manual slot mode", () => {
    const el = makeList();
    localStorage.setItem("cc_chat_slot_mode", "manual");
    state.pendingNewSession = draftState("pending-1");

    renderSidebar(el);
    vi.runAllTimers();

    const draftLi = el.querySelector('li[data-placeholder-id="pending-1"]');
    expect(draftLi?.hasAttribute("data-kbd-hint")).toBe(false);
  });
});
