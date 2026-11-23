// @vitest-environment jsdom
//
// A put-away main chat is closed (Joe 2026-11-23: "Put away was basically meant to mean that it's
// closed"). The daemon leaves it and its subs out of every list, so the front end never holds it in
// `state.sessions`; the two reopen doors (the project dashboard's "Open main chat" and a new chat's
// "Reopens ..." line) read it from `state.putAway`, filled by `list_put_away`. The refresh must not
// treat the missing row as a dead chat (its parked cards and unread marks wait for the reopen).

import { describe, it, expect, vi, beforeEach } from "vitest";

globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);
if (!globalThis.CSS) globalThis.CSS = window.CSS ?? { escape: (s) => s };
// The desktop webview: the phone (no Tauri global) cannot reopen, so it never reads the family.
window.__TAURI__ = {};

const rows = vi.hoisted(() => ({ list: [], away: [], awayFails: false }));
const invoke = vi.hoisted(() =>
  vi.fn(async (cmd) => {
    if (cmd === "list_instances") return rows.list;
    if (cmd === "list_put_away") {
      if (rows.awayFails) throw new Error("no such command");
      return rows.away;
    }
    if (cmd === "reopen_main_chat") return { state: { subs: [] } };
    return undefined;
  }),
);
vi.mock("../src/shared/ipc.ts", () => ({ invoke }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: vi.fn() }));

const { refreshSessions } = await import("../src/views/sessions/sidebar.ts");
const { state } = await import("../src/views/sessions/state.ts");
const put = await import("../src/views/sessions/put-away.ts");
const { storePendingPrompt, pendingPromptSessionIds, adoptSubchatsOn } = await import(
  "../src/views/sessions/permission-modal/gating.ts"
);
const { setProjectMainChatsForTest, openableMainFor } = await import("../src/views/sessions/project-main-chats.ts");
const { reopenIfPutAway } = await import("../src/views/sessions/reopen-main.ts");
const { draftReopenTarget } = await import("../src/views/sessions/draft-subchats.ts");

const AWAY = "2026-11-23T10:00:00Z";
const inst = (over = {}) => ({
  session_id: "s", pid: 1, cwd: "C:/Projects/cv", project_id: "p-cv", kind: "interactive", is_remote: false,
  started_at: "2026-11-12T10:00:00Z", transcript_path: null, name: "chat", ended_at: null, end_reason: null,
  busy: false, awaiting: null, closing: false, frozen: false, subchat_of: null, subchat_finished: false, machine: null,
  progress: { plan: null, state_since: null },
  ...over,
});
const main = inst({ session_id: "main", hidden_at: AWAY });
const sub = inst({ session_id: "sub", subchat_of: "main" });

beforeEach(() => {
  invoke.mockClear();
  rows.list = [];
  rows.away = [];
  rows.awayFails = false;
  state.sessions = [];
  state.putAway = [];
  state.selectedId = null;
  state.pendingNewSession = null;
  localStorage.clear();
  adoptSubchatsOn("main");
  setProjectMainChatsForTest([{ id: "p-cv", path: "C:/Projects/cv", name: "cv-site", mainChatId: "main" }]);
});

describe("the refresh keeps a put-away chat out of the list", () => {
  it("fills state.putAway from list_put_away and leaves state.sessions to the listing", async () => {
    rows.list = [inst({ session_id: "plain" })];
    rows.away = [main, sub];
    await refreshSessions();
    expect(state.sessions.map((s) => s.session_id)).toEqual(["plain"]);
    expect(state.putAway.map((s) => s.session_id)).toEqual(["main", "sub"]);
  });

  it("a put-away chat's parked card is not dropped as a dead chat's", async () => {
    storePendingPrompt("sub", { kind: "question", payload: { id: "q1", session_id: "sub", display_session_id: "main" } });
    rows.away = [main, sub];
    await refreshSessions();
    expect(pendingPromptSessionIds().has("main")).toBe(true);
  });

  it("a card of a chat that really is gone is still dropped", async () => {
    storePendingPrompt("gone", { kind: "question", payload: { id: "q2", session_id: "gone" } });
    await refreshSessions();
    expect(pendingPromptSessionIds().has("gone")).toBe(false);
  });

  it("a failed put-away read leaves the list whole and the doors empty", async () => {
    rows.list = [inst({ session_id: "plain" })];
    rows.awayFails = true;
    expect(await refreshSessions()).toBe(true);
    expect(state.sessions).toHaveLength(1);
    expect(state.putAway).toEqual([]);
  });
});

describe("readPutAway", () => {
  it("is empty on the phone and asks nothing", async () => {
    delete window.__TAURI__;
    try {
      expect(await put.readPutAway()).toEqual([]);
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      window.__TAURI__ = {};
    }
  });
});

describe("withPutAway", () => {
  it("adds the family behind the listing and counts a row in both once", () => {
    const merged = put.withPutAway([inst({ session_id: "plain" }), main], [main, sub]);
    expect(merged.map((s) => s.session_id)).toEqual(["plain", "main", "sub"]);
  });

  it("returns the listing itself when nothing is put away", () => {
    const list = [inst()];
    expect(put.withPutAway(list, [])).toBe(list);
  });
});

describe("the reopen doors still reach a put-away chat", () => {
  it("the dashboard's Open main chat finds it with its paused subs", () => {
    state.putAway = [main, sub];
    expect(openableMainFor("C:/Projects/cv", state.sessions)).toBeNull();
    expect(openableMainFor("C:/Projects/cv", put.withPutAway(state.sessions, state.putAway))).toMatchObject({
      putAway: true,
      paused: 1,
    });
  });

  it("a new chat's draft names the chat it reopens", () => {
    state.putAway = [main, sub];
    state.pendingNewSession = { projectPath: "C:/Projects/cv" };
    expect(draftReopenTarget({})?.chat.session_id).toBe("main");
  });

  it("reopening asks the daemon for a chat that is only in the put-away list", async () => {
    state.putAway = [main];
    await reopenIfPutAway("main");
    expect(invoke.mock.calls.some((c) => c[0] === "reopen_main_chat" && c[1].sessionId === "main")).toBe(true);
  });
});
