// @vitest-environment jsdom
//
// Regression for: "start a new chat, close it, start another new chat — the
// second draft never appears in the sidebar" (no messages sent).
//
// Root cause was in renderSidebar: every pending draft used a CONSTANT
// reconcile key ("pending"). Discarding draft #1 put that key into the
// close-animation suppression set; because draft #2 reused the exact same key,
// the suppression never cleared (the key was still present in entries) and the
// new draft was filtered out — invisible until its key changed (i.e. a sent
// message turned it into a real `s:<id>` session). Keying each draft by its
// unique placeholderId fixes it.
//
// This drives the real renderSidebar so a revert to a constant key is caught.

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

describe("consecutive new-chat drafts in the sidebar", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
    state.sessions = [];
    state.parkedDrafts = [];
    state.filter = "";
    state.selectedId = null;
    state.pendingNewSession = null;
  });

  it("renders the second draft after the first is discarded", () => {
    const el = makeList();

    // Open draft #1.
    state.pendingNewSession = draftState("P1");
    renderSidebar(el);
    vi.advanceTimersByTime(1000);
    expect(el.querySelector('li.pending[data-placeholder-id="P1"]')).not.toBeNull();

    // Discard draft #1 (begins its exit animation).
    state.pendingNewSession = null;
    renderSidebar(el);

    // Open draft #2 immediately (draft #1 may still be exiting).
    state.pendingNewSession = draftState("P2");
    renderSidebar(el);
    vi.advanceTimersByTime(1000);

    // Draft #2 must be visible — the constant-key bug hid it here.
    const p2 = el.querySelector('li.pending[data-placeholder-id="P2"]');
    expect(p2).not.toBeNull();
  });

  it("gives each draft a distinct reconcile key (unique placeholderId)", () => {
    const el = makeList();
    state.pendingNewSession = draftState("A1");
    renderSidebar(el);
    vi.advanceTimersByTime(1000);
    const first = el.querySelector("li.pending")?.dataset.placeholderId;

    state.pendingNewSession = null;
    renderSidebar(el);
    state.pendingNewSession = draftState("A2");
    renderSidebar(el);
    vi.advanceTimersByTime(1000);
    // A1 may still be leaving, so look for A2 by its own key.
    const second = el.querySelector('li.pending[data-placeholder-id="A2"]')?.dataset.placeholderId;

    expect(first).toBe("A1");
    expect(second).toBe("A2");
  });
});
