// @vitest-environment jsdom
//
// A message staged on a chat that is then put away stays staged: the daemon refuses every send to a
// put-away chat (`PUT_AWAY:`), and the background flush clears the held set before that answer, so a
// flush here would lose Joe's text. The sidebar's refresh must leave a put-away family alone.

import { describe, it, expect, vi, beforeEach } from "vitest";

globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);
if (!globalThis.CSS) globalThis.CSS = window.CSS ?? { escape: (s) => s };

const rows = vi.hoisted(() => ({ list: [] }));
const invoke = vi.hoisted(() => vi.fn(async (cmd) => (cmd === "list_instances" ? rows.list : [])));
vi.mock("../src/shared/ipc.ts", () => ({ invoke }));

const { refreshSessions } = await import("../src/views/sessions/sidebar.ts");
const { state } = await import("../src/views/sessions/state.ts");

const inst = (over = {}) => ({
  session_id: "s", pid: 1, cwd: "C:/Projects/cv", project_id: "p-cv", kind: "interactive", is_remote: false,
  started_at: "2026-11-12T10:00:00Z", transcript_path: null, name: "chat", ended_at: null, end_reason: null,
  busy: false, awaiting: null, closing: false, frozen: false, subchat_of: null, subchat_finished: false, machine: null,
  progress: { plan: null, state_since: null },
  ...over,
});

const flushBackground = vi.fn(async () => {});
const onCompletion = vi.fn();

beforeEach(() => {
  flushBackground.mockClear();
  onCompletion.mockClear();
  state.selectedId = null;
  state.heldMessages = {
    hasItemsFor: () => true,
    hasItemsForActive: () => true,
    hasAuqAnswerFor: () => false,
    flushBackground,
    onCompletion,
  };
});

describe("held messages and a put-away chat", () => {
  it("a background chat's staged messages go out when it is idle (control)", async () => {
    rows.list = [inst({ session_id: "plain" })];
    await refreshSessions();
    expect(flushBackground).toHaveBeenCalledTimes(1);
  });

  it("a put-away main chat and its subs keep their staged messages", async () => {
    rows.list = [inst({ session_id: "main", hidden_at: "2026-11-21T10:00:00Z" }), inst({ session_id: "sub", subchat_of: "main" })];
    await refreshSessions();
    expect(flushBackground).not.toHaveBeenCalled();
  });

  it("the open put-away chat does not flush on completion either", async () => {
    rows.list = [inst({ session_id: "main", hidden_at: "2026-11-21T10:00:00Z" })];
    state.selectedId = "main";
    await refreshSessions();
    expect(onCompletion).not.toHaveBeenCalled();
  });

  it("the open ordinary chat still flushes on completion (control)", async () => {
    rows.list = [inst({ session_id: "plain" })];
    state.selectedId = "plain";
    await refreshSessions();
    expect(onCompletion).toHaveBeenCalledTimes(1);
  });
});
