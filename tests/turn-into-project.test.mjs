// @vitest-environment jsdom
// "Turn into a project" (pc-1806 step 8): who the chat menu offers it to, and the rows the dialog
// shows. The dialog itself and the daemon call are in e2e/view-harness/turn-into-project.view.spec.ts.

import { describe, it, expect, beforeEach } from "vitest";
import { canTurnIntoProject, folderName, movedRows } from "../src/views/sessions/turn-into-project-model.ts";
import { buildChatItems } from "../src/views/sessions/chat-menu-items.ts";
import { state } from "../src/views/sessions/state.ts";

const VAULT = "C:\\Users\\joe\\Documents\\ObsidianVault";

const inst = (over = {}) => ({
  session_id: "s", pid: 1, cwd: VAULT, project_id: "vault", kind: "interactive", is_remote: false,
  started_at: "2026-11-22T10:00:00Z", transcript_path: null, name: "chat", ended_at: null, end_reason: null,
  busy: false, awaiting: null, closing: false, subchat_of: null, subchat_finished: false, progress: { plan: null, state_since: null },
  ...over,
});

// The desktop shell is what makes isRemote() false; the phone page has no __TAURI__.
beforeEach(() => {
  window.__TAURI__ = {};
});

describe("canTurnIntoProject", () => {
  it("is for an open ordinary chat in the No project folder", () => {
    expect(canTurnIntoProject(inst(), VAULT)).toBe(true);
  });

  it("is never offered on the phone, where the daemon call has no folder picker", () => {
    delete window.__TAURI__;
    expect(canTurnIntoProject(inst(), VAULT)).toBe(false);
  });

  it("is not for a chat that already has a project, a sub, an ended chat or a mirrored one", () => {
    expect(canTurnIntoProject(inst({ cwd: "C:/Projects/cv" }), "C:/Projects/cv")).toBe(false);
    expect(canTurnIntoProject(inst({ subchat_of: "m" }), VAULT)).toBe(false);
    expect(canTurnIntoProject(inst({ ended_at: "2026-11-22T11:00:00Z" }), VAULT)).toBe(false);
    expect(canTurnIntoProject(inst({ machine: { id: "m2", label: "Studio", online: true } }), VAULT)).toBe(false);
    expect(canTurnIntoProject(undefined, VAULT)).toBe(false);
  });
});

describe("movedRows", () => {
  it("always says the conversation goes, and counts subs and cards only when there are some", () => {
    expect(movedRows({ subs: 0, remote_subs: 0, cards: 0 })).toEqual([
      "The conversation, copied into the new main chat",
      "The decisions log, Answers and previews",
    ]);
    const rows = movedRows({ subs: 2, remote_subs: 1, cards: 1 });
    expect(rows).toContain("3 subs, still running or finished");
    expect(rows).toContain("1 sub card");
    expect(movedRows({ subs: 1, remote_subs: 0, cards: 0 })).toContain("1 sub, still running or finished");
  });
});

describe("folderName", () => {
  it("is the folder's own name, whatever the separators", () => {
    expect(folderName("C:\\Code\\shop")).toBe("shop");
    expect(folderName("/home/joe/shop/")).toBe("shop");
  });
});

describe("the chat menu item", () => {
  beforeEach(() => {
    state.sessions = [inst({ session_id: "scratch" }), inst({ session_id: "proj", cwd: "C:/Projects/cv" })];
  });
  const ctx = (over) => ({
    kind: "live", sessionId: "scratch", cwd: VAULT, pid: 1, readOnly: false, autoAcceptOn: false,
    subchatsOn: false, isHidden: false, ...over,
  });
  const item = (over) => buildChatItems(ctx(over)).find((i) => i.label === "Turn into a project");

  it("is offered on a No project chat and runs", () => {
    expect(item({})?.run).toBeTypeOf("function");
  });

  it("is absent from a project chat, a draft and a sub", () => {
    expect(item({ sessionId: "proj", cwd: "C:/Projects/cv" })).toBeUndefined();
    expect(item({ kind: "draft", sessionId: null })).toBeUndefined();
    state.sessions = [inst({ session_id: "scratch", subchat_of: "m" })];
    expect(item({ isSub: true })).toBeUndefined();
  });

  it("is disabled, with the reason, for a put-away chat and a mirrored one", () => {
    expect(item({ putAway: true })).toMatchObject({ run: undefined, disabledReason: expect.stringContaining("reopen") });
    state.sessions = [inst({ session_id: "scratch" })];
    expect(item({ mirrored: true })?.run).toBeUndefined();
  });
});
