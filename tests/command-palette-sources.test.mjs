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
const { shortcutCommands, settingsCommands, chatCommands, thisChatCommands, whenDoneCommands, draftCommands } =
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

  describe("Switch branch warnings", () => {
    const cwd = "C:\\Users\\tecno\\Desktop\\Projects\\demo";
    const notes = async (dirty, instances) => {
      state.sessions = [live("a", "Alpha")];
      state.selectedId = "a";
      invokeMock.mockImplementation(async (cmd) => {
        if (cmd === "get_git_dirty") {
          if (dirty instanceof Error) throw dirty;
          return dirty;
        }
        if (cmd === "list_instances") return instances;
        return undefined;
      });
      return thisChatCommands().find((r) => r.title === "Switch branch").stage.loadNotes();
    };

    it("says how many uncommitted files will come along, in Code mode's words", async () => {
      expect(await notes(["a.ts"], [])).toEqual(["1 uncommitted file will come with you"]);
      expect(await notes(["a.ts", "b.ts"], [])).toEqual(["2 uncommitted files will come with you"]);
    });

    it("warns when another live session is in the same repo", async () => {
      const peer = { session_id: "b", cwd, ended_at: null };
      expect(await notes([], [peer])).toEqual(["Another Conductor session is active in this repo"]);
    });

    it("ignores this chat itself, an ended session and one in another repo", async () => {
      const own = { session_id: "a", cwd, ended_at: null };
      const ended = { session_id: "b", cwd, ended_at: "2026-01-01" };
      const elsewhere = { session_id: "c", cwd: "C:\\other", ended_at: null };
      expect(await notes([], [own, ended, elsewhere])).toEqual([]);
    });

    it("lists the peer warning first, then the dirty one", async () => {
      const peer = { session_id: "b", cwd, ended_at: null };
      expect(await notes(["a.ts"], [peer])).toEqual([
        "Another Conductor session is active in this repo",
        "1 uncommitted file will come with you",
      ]);
    });

    it("counts a failed dirty read as nothing to warn about", async () => {
      expect(await notes(new Error("git missing"), [])).toEqual([]);
    });
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
