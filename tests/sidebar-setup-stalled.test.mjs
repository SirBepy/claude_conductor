// @vitest-environment jsdom
//
// Daemon boot-state surfaces. The centered pane (paneEmptyStateHtml) owns the
// "Setting up..." indicator: an ANIMATED spinner in the middle of the screen
// while the daemon is connecting, an amber warning once the stall flag is set
// (daemon stayed unreachable past the threshold - the 2026-06-12 incident had
// it spinning forever with no hint), and "Select or create a session" when
// connected. The SIDEBAR stays blank while disconnected - it must not
// duplicate the loading state in a cramped row (and the old empty-state rows
// once piled up duplicates because they had no reconcile key).

import { describe, it, expect, vi, beforeEach } from "vitest";

globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);
if (!globalThis.CSS) globalThis.CSS = window.CSS ?? { escape: (s) => s };

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => ({})) }));

const { renderSidebar } = await import("../src/views/sessions/sidebar.ts");
const { paneEmptyStateHtml } = await import("../src/views/sessions/sessions-helpers.ts");
const { state } = await import("../src/views/sessions/state.ts");

function makeList() {
  const ul = document.createElement("ul");
  ul.id = "sessions-list";
  ul.className = "sessions-list";
  document.body.appendChild(ul);
  return ul;
}

describe("paneEmptyStateHtml (centered daemon boot state)", () => {
  it("shows the animated setup spinner while the daemon is connecting", () => {
    for (const connected of [null, false]) {
      const html = paneEmptyStateHtml(connected, false);
      expect(html).toContain("session-empty--setup");
      expect(html).toContain("ph-spinner");
      expect(html).toContain("Setting up");
    }
  });

  it("shows the amber stalled warning once the stall flag is set", () => {
    const html = paneEmptyStateHtml(false, true);
    expect(html).toContain("session-empty--stalled");
    expect(html).toContain("ph-warning");
    expect(html).toContain("Daemon unreachable");
    expect(html).not.toContain("Setting up");
  });

  it("shows select-or-create once connected (stall flag irrelevant)", () => {
    const html = paneEmptyStateHtml(true, true);
    expect(html).toContain("Select or create a session");
    expect(html).not.toContain("session-empty--setup");
  });
});

describe("sidebar empty states", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
    state.sessions = [];
    state.parkedDrafts = [];
    state.filter = "";
    state.selectedId = null;
    state.pendingNewSession = null;
    state.daemonConnected = null;
    state.daemonSetupStalled = false;
  });

  it("renders NO rows while the daemon is disconnected (pane owns the state)", () => {
    const el = makeList();
    renderSidebar(el);
    vi.runAllTimers();
    expect(el.querySelectorAll("li").length).toBe(0);

    state.daemonSetupStalled = true;
    renderSidebar(el);
    vi.runAllTimers();
    expect(el.querySelectorAll("li").length).toBe(0);
  });

  it("shows 'No active sessions' once connected with an empty list", () => {
    const el = makeList();
    state.daemonConnected = true;
    renderSidebar(el);
    vi.runAllTimers();
    const row = el.querySelector("li.sessions-empty-row");
    expect(row).not.toBeNull();
    expect(row.textContent).toContain("No active sessions");
  });

  it("re-rendering never piles up duplicate empty-state rows", () => {
    // The incident screenshot: multiple empty-state rows coexisting. They had
    // no reconcile identity (keyOf returned ""), so every re-render appended
    // a fresh copy.
    const el = makeList();
    state.daemonConnected = true;
    renderSidebar(el);
    renderSidebar(el);
    renderSidebar(el);
    vi.runAllTimers();
    expect(el.querySelectorAll("li.sessions-empty-row").length).toBe(1);
  });

  it("never shows an empty-state row when sessions exist", () => {
    const el = makeList();
    state.daemonConnected = true;
    state.sessions = [
      {
        session_id: "s1",
        pid: 0,
        cwd: "C:/proj",
        project_id: "p",
        kind: "interactive",
        is_remote: false,
        started_at: "2026-06-12T00:00:00Z",
        transcript_path: null,
        name: null,
        ended_at: null,
        end_reason: null,
        busy: false,
        model: "",
        effort: "",
        awaiting: null,
      },
    ];
    renderSidebar(el);
    vi.runAllTimers();
    expect(el.querySelector(".sessions-empty-row")).toBeNull();
    expect(el.querySelector('li[data-session-id="s1"]')).not.toBeNull();
  });
});
