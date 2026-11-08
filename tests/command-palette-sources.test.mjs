// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// What the palette lists: shortcuts that can fire right now, Settings pages and
// single settings, the live chats in sidebar order, and the open chat's actions.
const invokeMock = vi.fn();
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));
let remote = false;
vi.mock("../src/shared/transport.ts", async (orig) => ({ ...(await orig()), isRemote: () => remote }));
Element.prototype.scrollIntoView ??= () => {};

const shortcuts = await import("../src/shared/shortcuts.ts");
const { state } = await import("../src/views/sessions/state.ts");
const { shortcutCommands, settingsCommands, chatCommands, thisChatCommands, whenDoneCommands, draftCommands, draftRowCommands } =
  await import("../src/views/command-palette/sources.ts");

const live = (id, name, extra = {}) => ({
  session_id: id, name, cwd: "C:\\Users\\tecno\\Desktop\\Projects\\demo", pid: 1,
  kind: "interactive", ended_at: null, project_id: "p", ...extra,
});

beforeEach(() => {
  remote = false;
  state.whenDone = null;
  state.pendingNewSession = null;
  invokeMock.mockReset();
  state.sessions = [];
  state.selectedId = null;
  state.sortedSessionIds = [];
  for (const d of shortcuts.getAll()) shortcuts.unregister(d.id);
});

describe("shortcut rows", () => {
  it("lists only shortcuts with a live handler, with their binding", () => {
    shortcuts.register("go-home", () => {});
    const rows = shortcutCommands();
    expect(rows.map((r) => r.title)).toEqual(["Go to Home"]);
    expect(rows[0].keys).toBe("ctrl+shift+h");
  });

  it("leaves out the palette itself, the composer escape and the numbered families", () => {
    for (const id of ["command-palette", "blur-composer", "open-chat-1", "new-chat-favorite-3", "new-chat"]) {
      shortcuts.register(id, () => {});
    }
    expect(shortcutCommands().map((r) => r.id)).toEqual(["shortcut:new-chat"]);
  });

  it("runs the shortcut's handler", () => {
    const handler = vi.fn();
    shortcuts.register("go-chats", handler);
    shortcutCommands()[0].run();
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("settings rows", () => {
  it("has a page row and a row per single setting, each saying which page it is on", () => {
    const rows = settingsCommands();
    expect(rows.find((r) => r.id === "settings:settings-power")?.title).toBe("Settings: Power & startup");
    const gaming = rows.find((r) => r.title === "Gaming mode");
    expect(gaming.detail).toBe("Settings › Power & startup");
  });
});

describe("chat rows", () => {
  it("lists live chats in the sidebar's order, skipping ended ones", () => {
    state.sessions = [live("a", "Alpha"), live("b", "Beta"), live("c", "Gone", { ended_at: "2026-01-01" })];
    state.sortedSessionIds = ["b", "a"];
    expect(chatCommands().map((r) => r.title)).toEqual(["Beta", "Alpha"]);
    expect(chatCommands()[0].detail).toBe("demo");
  });

  it("names a chat Claude has not titled yet", () => {
    state.sessions = [live("a", "")];
    expect(chatCommands()[0].title).toBe("New chat");
  });
});

describe("this chat rows", () => {
  it("is empty with nothing open", () => {
    expect(thisChatCommands()).toEqual([]);
  });

  it("offers the chat menu's actions plus Switch branch for the open chat", () => {
    state.sessions = [live("a", "Alpha")];
    state.selectedId = "a";
    const titles = thisChatCommands().map((r) => r.title);
    for (const t of ["Change account", "Change character", "Freeze chat", "Auto-accept", "Switch branch", "Open project in VS Code", "Close session"]) {
      expect(titles, t).toContain(t);
    }
    expect(titles).not.toContain("Open project in Dashboard");
  });

  it("keeps a toggle's id fixed while its title follows its state", () => {
    state.sessions = [live("a", "Alpha", { frozen: false })];
    state.selectedId = "a";
    const before = thisChatCommands().find((r) => r.title === "Freeze chat");
    state.sessions = [live("a", "Alpha", { frozen: true })];
    const after = thisChatCommands().find((r) => r.title === "Unfreeze chat");
    expect(after.id).toBe(before.id);
  });

  it("lists branches with the current one inert, and checks out the pick", async () => {
    state.sessions = [live("a", "Alpha")];
    state.selectedId = "a";
    invokeMock.mockImplementation(async (cmd) =>
      cmd === "get_recent_branches"
        ? [{ name: "main", current: true, short_sha: "abc1234", upstream: null }, { name: "dev", current: false, short_sha: null, upstream: null }]
        : undefined);
    const branch = thisChatCommands().find((r) => r.title === "Switch branch");
    const items = await branch.stage.load();
    expect(items.map((i) => i.title)).toEqual(["main", "dev"]);
    await items[0].run();
    expect(invokeMock).not.toHaveBeenCalledWith("checkout_branch", expect.anything());
    await items[1].run();
    expect(invokeMock).toHaveBeenCalledWith("checkout_branch", { cwd: "C:\\Users\\tecno\\Desktop\\Projects\\demo", name: "dev" });
  });

  it("disables Switch branch for a chat on another machine", () => {
    state.sessions = [live("a", "Alpha", { machine: { id: "m1", label: "Laptop" } })];
    state.selectedId = "a";
    const branch = thisChatCommands().find((r) => r.title === "Switch branch");
    expect(branch.disabledReason).toBe("Chat is on another machine");
  });
});

describe("when-done rows (moved in from the header menu)", () => {
  it("offers Sleep and Shutdown, and arms the chosen one", async () => {
    invokeMock.mockResolvedValue({ phase: "watching", action: "sleep", waiting_on: [] });
    const rows = whenDoneCommands();
    expect(rows.map((r) => r.title)).toEqual(["Sleep when done", "Shutdown when done"]);
    await rows[0].run();
    expect(invokeMock).toHaveBeenCalledWith("arm_when_done", { action: "sleep" });
  });

  it("adds a Cancel row and marks the armed one while a run is armed", () => {
    state.whenDone = { phase: "watching", action: "shutdown", waiting_on: [], countdown_remaining_secs: null, snoozed_until_unix_ms: null };
    const rows = whenDoneCommands();
    expect(rows.map((r) => r.title)).toContain("Cancel sleep/shutdown when done");
    expect(rows.find((r) => r.title === "Shutdown when done").detail).toContain("armed");
    expect(rows.find((r) => r.title === "Sleep when done").detail).toBeUndefined();
  });

  it("is absent on the phone, where the daemon has no when-done RPC", () => {
    remote = true;
    expect(whenDoneCommands()).toEqual([]);
  });
});

describe("draft rows", () => {
  it("offers Delete draft only while the open chat is the draft, and signals sessions.ts like the menu did", () => {
    expect(draftCommands()).toEqual([]);
    state.pendingNewSession = { placeholderId: "draft-1" };
    state.selectedId = "other";
    expect(draftCommands()).toEqual([]);
    state.selectedId = "draft-1";
    const seen = vi.fn();
    document.addEventListener("discard-pending-draft", seen);
    draftCommands()[0].run();
    expect(seen).toHaveBeenCalledOnce();
  });
});

describe("a right-clicked row (not the open chat)", () => {
  it("lists the clicked chat's actions while another chat is open", () => {
    state.sessions = [live("a", "Alpha"), live("b", "Beta", { frozen: true })];
    state.selectedId = "a";
    const titles = thisChatCommands("b").map((r) => r.title);
    expect(titles).toContain("Unfreeze chat");
    expect(thisChatCommands().map((r) => r.title)).toContain("Freeze chat");
  });

  it("has no View changes for a chat that is not on screen", () => {
    state.sessions = [live("a", "Alpha"), live("b", "Beta")];
    state.selectedId = "a";
    state.activeChatActions = { viewChanges: () => {} };
    const row = (id) => thisChatCommands(id).find((r) => r.title === "View changes");
    expect(row("a").run).toBeTypeOf("function");
    expect(row("b").run).toBeUndefined();
    expect(row("b").disabledReason).toBe("Open the chat to view changes");
    state.activeChatActions = null;
  });

  it("is empty for an unknown or draft id", () => {
    state.sessions = [live("a", "Alpha")];
    expect(thisChatCommands("nope")).toEqual([]);
    expect(thisChatCommands("pending-xyz")).toEqual([]);
  });

  it("gives a draft row Delete draft, which runs the row's own discard", () => {
    const onDiscard = vi.fn();
    const rows = draftRowCommands("C:\Projects\demo", onDiscard);
    expect(rows.map((r) => r.title)).toEqual(["Delete draft", "Open project in VS Code", "Open project in Terminal", "Open project in File Explorer"]);
    rows[0].run();
    expect(onDiscard).toHaveBeenCalledOnce();
  });
});
