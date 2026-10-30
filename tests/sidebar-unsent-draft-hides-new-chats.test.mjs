// @vitest-environment jsdom
// asserts: src/views/sessions/sidebar-entries.ts
//
// Regression for 2026-10-10: an unsent new-chat draft in a project (persisted
// in localStorage, so it survives an app restart) hid every chat that started
// in that project after the draft was opened - spawn_chat siblings, a respawn
// successor - for hours. The "pre-resolution" filter exists to hide our OWN
// `start_session` newcomer while its id is in flight, and that spawn only
// happens once the first message is sent.

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

function instance(id) {
  return {
    session_id: id,
    pid: 0,
    cwd: "C:/proj",
    project_id: "p",
    kind: "interactive",
    is_remote: false,
    started_at: "2026-10-10T17:20:00Z",
    transcript_path: null,
    name: null,
    ended_at: null,
    end_reason: null,
    busy: false,
    model: "",
    effort: "",
    awaiting: null,
    machine: null,
  };
}

function draft(firstMessageSent) {
  return {
    placeholderId: "pending-1",
    projectPath: "C:/proj",
    projectName: "proj",
    config: { model: "opus", effort: "high" },
    realId: null,
    firstMessageSent,
    preExistingSessionIds: new Set(["old"]),
    firstMessageSentAt: firstMessageSent ? Date.now() : null,
  };
}

describe("a pending draft and new chats in the same project", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
    state.parkedDrafts = [];
    state.filter = "";
    state.selectedId = null;
    state.daemonConnected = true;
    state.sessions = [instance("old"), instance("spawned")];
  });

  it("an unsent draft does not hide a chat started after it opened", () => {
    const el = makeList();
    state.pendingNewSession = draft(false);
    renderSidebar(el);
    vi.runAllTimers();
    expect(el.querySelector('li[data-session-id="old"]')).not.toBeNull();
    expect(el.querySelector('li[data-session-id="spawned"]')).not.toBeNull();
  });

  it("a sent draft still hides the newcomer while its real id is unresolved", () => {
    const el = makeList();
    state.pendingNewSession = draft(true);
    renderSidebar(el);
    vi.runAllTimers();
    expect(el.querySelector('li[data-session-id="old"]')).not.toBeNull();
    expect(el.querySelector('li[data-session-id="spawned"]')).toBeNull();
  });
});
