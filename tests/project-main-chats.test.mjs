// @vitest-environment jsdom
// jsdom: sessions-helpers reads settings off `window`; the gate imports the IPC layer.

import { describe, it, expect, beforeEach, vi } from "vitest";

const listProjects = vi.fn();
vi.mock("../src/shared/api.ts", () => ({ api: { listProjects: (...a) => listProjects(...a) } }));

const { adoptSubchatsOn } = await import("../src/views/sessions/permission-modal/gating.ts");
const { loadProjectMainChats, mainChatFor, listedAsProjectMain, setProjectMainChatsForTest, onProjectMainChatsChange } =
  await import("../src/views/sessions/project-main-chats.ts");
const { draftRouteTarget, forceDraftPlain } = await import("../src/views/sessions/draft-subchats.ts");
const { state } = await import("../src/views/sessions/state.ts");

const inst = (over = {}) => ({
  session_id: "s", pid: 1, cwd: "C:/Projects/cv", project_id: "p-cv", kind: "interactive", is_remote: false,
  started_at: "2026-11-12T10:00:00Z", transcript_path: null, name: "chat", ended_at: null, end_reason: null,
  busy: false, awaiting: null, closing: false, subchat_of: null, subchat_finished: false, progress: { plan: null, state_since: null },
  ...over,
});
const PROJECT = { id: "p-cv", path: "C:/Projects/cv", name: "cv-site", mainChatId: "main" };

describe("mainChatFor", () => {
  beforeEach(() => {
    setProjectMainChatsForTest([PROJECT]);
    adoptSubchatsOn("main");
  });

  it("names the pointed chat while it is open and in main-chat mode", () => {
    const main = inst({ session_id: "main", name: "CV redesign" });
    const found = mainChatFor("C:/Projects/cv", [main, inst({ session_id: "other" })]);
    expect(found?.chat.session_id).toBe("main");
    expect(found?.projectName).toBe("cv-site");
  });

  it("matches the folder however it is written", () => {
    const sessions = [inst({ session_id: "main" })];
    expect(mainChatFor("c:\\Projects\\CV\\", sessions)?.chat.session_id).toBe("main");
  });

  it("is none for a closed chat, a closing chat, a chat without the mode, an unknown folder and a sub", () => {
    expect(mainChatFor("C:/Projects/cv", [inst({ session_id: "main", ended_at: "2026-11-12T11:00:00Z" })])).toBeNull();
    expect(mainChatFor("C:/Projects/cv", [inst({ session_id: "main", closing: true })])).toBeNull();
    expect(mainChatFor("C:/Projects/cv", [inst({ session_id: "main", subchat_of: "x" })])).toBeNull();
    expect(mainChatFor("C:/Projects/elsewhere", [inst({ session_id: "main" })])).toBeNull();
    setProjectMainChatsForTest([{ ...PROJECT, mainChatId: "never-main" }]);
    expect(mainChatFor("C:/Projects/cv", [inst({ session_id: "never-main" })])).toBeNull();
  });

  it("is none when the project holds no pointer", () => {
    setProjectMainChatsForTest([{ ...PROJECT, mainChatId: null }]);
    expect(mainChatFor("C:/Projects/cv", [inst({ session_id: "main" })])).toBeNull();
  });
});

describe("listedAsProjectMain", () => {
  const main = inst({ session_id: "main" });
  const second = inst({ session_id: "second", started_at: "2026-11-12T12:00:00Z" });
  const beta = inst({ session_id: "beta", project_id: "p-beta" });
  beforeEach(() => {
    adoptSubchatsOn("main");
    adoptSubchatsOn("beta");
  });

  it("lists the pointed chat and only it in its project", () => {
    setProjectMainChatsForTest([PROJECT, { id: "p-beta", path: "C:/Projects/beta", name: "beta", mainChatId: "beta" }]);
    const all = [main, second, beta];
    expect(listedAsProjectMain(main, all)).toBe(true);
    expect(listedAsProjectMain(second, all)).toBe(false);
    expect(listedAsProjectMain(beta, all)).toBe(true);
  });

  it("ignores a pointer at a chat that is no longer in main-chat mode", () => {
    setProjectMainChatsForTest([{ ...PROJECT, mainChatId: "was-main" }]);
    // `was-main` never had the mode adopted here, so the real main chats still list.
    expect(listedAsProjectMain(second, [inst({ session_id: "was-main" }), second])).toBe(true);
  });

  it("falls back to listing every main chat when the project has no live pointer", () => {
    setProjectMainChatsForTest([{ ...PROJECT, mainChatId: null }]);
    expect(listedAsProjectMain(second, [main, second])).toBe(true);
    setProjectMainChatsForTest([{ ...PROJECT, mainChatId: "gone" }]);
    expect(listedAsProjectMain(second, [main, second])).toBe(true);
    setProjectMainChatsForTest([]);
    expect(listedAsProjectMain(second, [main, second])).toBe(true);
  });
});

describe("draftRouteTarget", () => {
  const config = { model: "opus", effort: "high", subchatsOn: true };

  beforeEach(() => {
    setProjectMainChatsForTest([PROJECT]);
    adoptSubchatsOn("main");
    state.sessions = [inst({ session_id: "main", name: "CV redesign" })];
    state.pendingNewSession = { placeholderId: "p1", projectPath: "C:/Projects/cv", projectName: "cv", config, realId: null, firstMessageSent: false };
  });

  it("sends the first message to the project's main chat", () => {
    expect(draftRouteTarget(config)?.chat.session_id).toBe("main");
  });

  it("forceDraftPlain makes the open draft a plain chat (a card action typed into it)", () => {
    document.body.innerHTML = `<div id="session-pane"></div>`;
    expect(draftRouteTarget(config)?.chat.session_id).toBe("main");
    forceDraftPlain();
    expect(state.pendingNewSession.config.plainChat).toBe(true);
    expect(draftRouteTarget(state.pendingNewSession.config)).toBeNull();
  });

  it("never swallows a draft that opened with its own message (a card chat, /pickup)", () => {
    expect(draftRouteTarget({ ...config, initialMessage: "/pickup" })).toBeNull();
  });

  it("goes nowhere with Plain chat instead on, for a chat on another machine, or without a main chat", () => {
    expect(draftRouteTarget({ ...config, plainChat: true })).toBeNull();
    expect(draftRouteTarget({ ...config, machineId: "peer" })).toBeNull();
    state.sessions = [];
    expect(draftRouteTarget(config)).toBeNull();
  });
});

describe("loadProjectMainChats", () => {
  it("reads each project's pointer and tells listeners", async () => {
    listProjects.mockResolvedValue([{ id: "p-cv", path: "C:/Projects/cv", name: "cv-site", main_chat_id: "main" }]);
    const seen = vi.fn();
    const stop = onProjectMainChatsChange(seen);
    await loadProjectMainChats();
    stop();
    expect(seen).toHaveBeenCalledTimes(1);
    adoptSubchatsOn("main");
    expect(mainChatFor("C:/Projects/cv", [inst({ session_id: "main" })])?.chat.session_id).toBe("main");
  });

  it("keeps what it had when the read fails", async () => {
    setProjectMainChatsForTest([PROJECT]);
    adoptSubchatsOn("main");
    listProjects.mockRejectedValue(new Error("link down"));
    await loadProjectMainChats();
    expect(mainChatFor("C:/Projects/cv", [inst({ session_id: "main" })])?.chat.session_id).toBe("main");
  });
});
