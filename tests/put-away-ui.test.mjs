// @vitest-environment jsdom
//
// Put away in the UI (pc-1806 step 5): a project's main chat is put away, not closed. The daemon marks the
// open row `hidden_at`; the front end reads that one field (put-away.ts) and words the close accordingly.

import { describe, it, expect, beforeEach, vi } from "vitest";

const { invokeMock, confirmMock, toastMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => undefined),
  confirmMock: vi.fn(async () => true),
  toastMock: vi.fn(),
}));

vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
vi.mock("../src/shared/api.ts", () => ({
  api: { playCharacterSlot: vi.fn(async () => undefined), listProjects: vi.fn(async () => []) },
}));
vi.mock("../src/shared/confirm.ts", () => ({ askConfirm: confirmMock }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: toastMock }));
vi.mock("../src/shared/http-transport.ts", () => ({
  RemoteUnavailableError: class RemoteUnavailableError extends Error {},
}));
vi.mock("../src/views/sessions/session-characters.ts", () => ({ characterForSession: () => null }));
vi.mock("../src/views/sessions/active-session-account.ts", () => ({
  changeCharacterForSession: vi.fn(),
  changeAccountForSession: vi.fn(),
}));
vi.mock("../src/views/sessions/send-with-failure-recovery.ts", () => ({ sendWithFailureRecovery: vi.fn() }));

const { adoptSubchatsOn } = await import("../src/views/sessions/permission-modal/gating.ts");
const { setProjectMainChatsForTest } = await import("../src/views/sessions/project-main-chats.ts");
const { state } = await import("../src/views/sessions/state.ts");
const put = await import("../src/views/sessions/put-away.ts");
const { closeIsPutAway, closeVerb, closeNeedsConfirm, closeNeedsApproval, closeChat, closeChatWithConfirm } =
  await import("../src/views/sessions/close-chat.ts");
const { buildRowMenuBlock } = await import("../src/views/sessions/chat-menu.ts");

const inst = (over = {}) => ({
  session_id: "s", pid: 1, cwd: "C:/Projects/cv", project_id: "p-cv", kind: "interactive", is_remote: false,
  started_at: "2026-11-12T10:00:00Z", transcript_path: null, name: "chat", ended_at: null, end_reason: null,
  busy: false, awaiting: null, closing: false, subchat_of: null, subchat_finished: false, machine: null,
  progress: { plan: null, state_since: null },
  ...over,
});
const AWAY = "2026-11-21T10:00:00Z";
const PROJECT = { id: "p-cv", path: "C:/Projects/cv", name: "cv-site", mainChatId: "main" };
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async () => undefined);
  confirmMock.mockReset();
  confirmMock.mockImplementation(async () => true);
  toastMock.mockReset();
  localStorage.clear();
  setProjectMainChatsForTest([PROJECT]);
  adoptSubchatsOn("main");
  state.sessions = [];
});

describe("put-away.ts reads the daemon's hidden_at", () => {
  it("a chat is put away only while its row is open and flagged", () => {
    expect(put.isPutAway(inst({ hidden_at: AWAY }))).toBe(true);
    expect(put.isPutAway(inst())).toBe(false);
    expect(put.isPutAway(inst({ hidden_at: AWAY, ended_at: "2026-11-21T11:00:00Z" }))).toBe(false);
    expect(put.isPutAway(undefined)).toBe(false);
  });

  it("the family is the put-away main chat and its subs, and nothing else", () => {
    const main = inst({ session_id: "main", hidden_at: AWAY });
    const sub = inst({ session_id: "sub", subchat_of: "main" });
    const other = inst({ session_id: "other" });
    const all = [main, sub, other];
    expect(put.inPutAwayFamily(main, all)).toBe(true);
    expect(put.inPutAwayFamily(sub, all)).toBe(true);
    expect(put.inPutAwayFamily(other, all)).toBe(false);
    // A sub of a main chat that is NOT put away is not in the family.
    expect(put.inPutAwayFamily(sub, [inst({ session_id: "main" }), sub])).toBe(false);
  });

  it("paused subs are the ones with work left, and the line counts them", () => {
    const main = inst({ session_id: "main", hidden_at: AWAY });
    const all = [
      main,
      inst({ session_id: "a", subchat_of: "main" }),
      inst({ session_id: "b", subchat_of: "main" }),
      inst({ session_id: "done", subchat_of: "main", subchat_finished: true }),
      inst({ session_id: "gone", subchat_of: "main", ended_at: "2026-11-21T09:00:00Z" }),
    ];
    expect(put.pausedSubs("main", all).map((s) => s.session_id)).toEqual(["a", "b"]);
    expect(put.putAwayLine(main, all)).toBe("Put away, 2 subs paused");
    expect(put.putAwayLine(main, [main, all[1]])).toBe("Put away, 1 sub paused");
    expect(put.putAwayLine(main, [main])).toBe("Put away, nothing to resume");
  });

  it("the Hidden view lists Joe's own hidden chats and every put-away chat with its pinned subs", () => {
    localStorage.setItem("cc_hidden_sessions", JSON.stringify(["mine"]));
    const all = [
      inst({ session_id: "main", hidden_at: AWAY }),
      inst({ session_id: "sub", subchat_of: "main", pinned_to_sidebar: true }),
      inst({ session_id: "mine" }),
      inst({ session_id: "plain" }),
    ];
    expect([...put.hiddenIdsOf(all)].sort()).toEqual(["main", "mine", "sub"]);
  });
});

describe("the close of a project's main chat is a put-away", () => {
  it("only the pointed main chat is put away; every other chat closes", () => {
    state.sessions = [inst({ session_id: "main" }), inst({ session_id: "other" })];
    expect(closeIsPutAway("main")).toBe(true);
    expect(closeVerb("main")).toBe("Put away");
    expect(closeVerb("other")).toBe("Close");
    expect(closeVerb(null)).toBe("Close");
  });

  it("with no pointer loaded the word stays Close: a soft word must never hide a real close", () => {
    setProjectMainChatsForTest([{ ...PROJECT, mainChatId: null }]);
    state.sessions = [inst({ session_id: "main" })];
    expect(closeVerb("main")).toBe("Close");
  });

  it("a busy main chat asks nothing about discarding: the daemon waits the turn out", () => {
    state.sessions = [inst({ session_id: "main", busy: true }), inst({ session_id: "other", busy: true })];
    expect(closeNeedsConfirm("main")).toBe(false);
    expect(closeNeedsConfirm("other")).toBe(true);
  });

  it("is a held close, so a caller starts no exit animation (the death cue is gated on the same answer)", () => {
    state.sessions = [inst({ session_id: "main" })];
    expect(closeNeedsApproval("main")).toBe(true);
  });

  it("the menu's Put away never cancels a turn, shows a toast and does not report the chat closed", async () => {
    state.sessions = [inst({ session_id: "main", busy: true, name: "CV redesign" })];
    invokeMock.mockImplementation(async (cmd) => (cmd === "clear_session" ? true : undefined));
    const closed = vi.fn();
    document.addEventListener("cc:session-closed", closed);
    const result = await closeChat("main");
    document.removeEventListener("cc:session-closed", closed);
    expect(result).toBe(false);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("clear_session", { sessionId: "main" });
    expect(invokeMock).not.toHaveBeenCalledWith("cancel_turn", expect.anything());
    expect(closed).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0][0]).toMatch(/away/);
  });

  it("Ctrl+W puts the main chat away at once, with no confirm dialog and no cancelled turn", async () => {
    state.sessions = [inst({ session_id: "main", busy: true })];
    invokeMock.mockImplementation(async (cmd) => (cmd === "clear_session" ? true : undefined));
    await closeChatWithConfirm("main");
    expect(confirmMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("clear_session", { sessionId: "main" });
    expect(invokeMock).not.toHaveBeenCalledWith("cancel_turn", expect.anything());
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+W on any other chat is still the plain Close prompt", async () => {
    state.sessions = [inst({ session_id: "other", busy: true })];
    await closeChatWithConfirm("other");
    const [text, opts] = confirmMock.mock.calls[0];
    expect(text).toBe("A turn is in progress. Close and discard it?");
    expect(opts).toMatchObject({ confirmLabel: "Discard", danger: true });
    await flush();
    expect(invokeMock).toHaveBeenCalledWith("cancel_turn", { sessionId: "other" });
  });
});

describe("a put-away chat takes nothing from the UI", () => {
  it("a new-chat draft in the project does not route to the put-away main chat", async () => {
    const { mainChatFor } = await import("../src/views/sessions/project-main-chats.ts");
    expect(mainChatFor("C:/Projects/cv", [inst({ session_id: "main" })])?.chat.session_id).toBe("main");
    expect(mainChatFor("C:/Projects/cv", [inst({ session_id: "main", hidden_at: AWAY })])).toBeNull();
  });

  it("quick-reply chips are not offered on a put-away chat or one of its finished subs", async () => {
    const { nextChips } = await import("../src/views/sessions/next-chips.ts");
    const done = { awaiting: "done", busy: false, closing: false, ended_at: null, frozen: false, kind: "interactive" };
    const ctx = { enabled: true, inst: done, hasHeld: false, nextActions: ["Yes"] };
    expect(nextChips(ctx)).toEqual(["Yes"]);
    expect(nextChips({ ...ctx, putAway: true })).toEqual([]);
  });

  it("Ctrl+W and the close action on an already put-away chat say so and ask the daemon nothing", async () => {
    state.sessions = [inst({ session_id: "main", hidden_at: AWAY })];
    await closeChatWithConfirm("main");
    expect(await closeChat("main")).toBe(false);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledTimes(2);
    expect(toastMock.mock.calls[0][0]).toMatch(/Already put away/);
  });

  it("only an interactive chat is the pointed main chat, like the daemon's own check", async () => {
    const { isPointedMainChat } = await import("../src/views/sessions/project-main-chats.ts");
    const all = [inst({ session_id: "main", kind: "automated" })];
    expect(isPointedMainChat(all[0], all)).toBe(false);
    const ok = [inst({ session_id: "main" })];
    expect(isPointedMainChat(ok[0], ok)).toBe(true);
  });
});

describe("the chat menu", () => {
  const ctxFor = (id, over = {}) => ({
    kind: "live", sessionId: id, cwd: "/repo", pid: 1, readOnly: false, autoAcceptOn: false, isHidden: false,
    isJarvis: false, isFrozen: false, ...over,
  });
  const labels = (el) => [...el.querySelectorAll(".smore-item")].map((b) => b.textContent);

  it("a project's main chat offers Put away, a calm item (not danger red); another chat offers Close session", () => {
    state.sessions = [inst({ session_id: "main" }), inst({ session_id: "other" })];
    const main = buildRowMenuBlock(ctxFor("main"), () => {});
    expect(labels(main)).toContain("Put away");
    expect(main.querySelector(".smore-danger")).toBeNull();
    const other = buildRowMenuBlock(ctxFor("other"), () => {});
    expect(labels(other)).toContain("Close session");
    expect(other.querySelector(".smore-danger")).not.toBeNull();
  });

  it("clicking Put away calls the same close door", async () => {
    state.sessions = [inst({ session_id: "main" })];
    const block = buildRowMenuBlock(ctxFor("main"), () => {});
    [...block.querySelectorAll(".smore-item")].find((b) => b.textContent === "Put away").click();
    await flush();
    expect(invokeMock).toHaveBeenCalledWith("clear_session", { sessionId: "main" });
  });

  it("an already put-away chat has no close item and its hide switch is off", () => {
    state.sessions = [inst({ session_id: "main", hidden_at: AWAY })];
    const block = buildRowMenuBlock(ctxFor("main", { putAway: true }), () => {});
    expect(labels(block)).not.toContain("Put away");
    expect(labels(block)).not.toContain("Close session");
    const hide = [...block.querySelectorAll(".smore-item")].find((b) => /hide chat/i.test(b.textContent));
    expect(hide.classList.contains("is-disabled")).toBe(true);
  });
});
