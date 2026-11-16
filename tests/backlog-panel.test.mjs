// @vitest-environment jsdom
//
// The mounted Backlog panel: what it fetches (and with which args for a chat
// mirrored from a peer), and that the footer of write actions exists only on
// the desktop for a chat this machine hosts.

import { describe, it, expect, vi, beforeEach } from "vitest";

const calls = [];
const env = { remote: false, sessions: [] };
const backlog = {
  groups: ["Release"],
  todos: [
    { name: "pc-0001-a.md", path: "C:\\p\\.claude\\todos\\pc-0001-a.md", id: "pc-0001", title: "First", summary: "Sum", origin: "dev", todo_type: "task", worth: 6, complexity: "HARD", claimed: false, group: "Release", plan_index: 0, mtime_ms: 1 },
    { name: "pc-0002-b.md", path: "C:\\p\\.claude\\todos\\pc-0002-b.md", id: "pc-0002", title: "Second", summary: null, origin: "ai", todo_type: "task", worth: null, complexity: null, claimed: true, group: null, plan_index: null, mtime_ms: 2 },
  ],
};
const doc = (id) => ({
  entry: backlog.todos.find((t) => t.id === id),
  why: id === "pc-0001" ? "Because Joe said so." : null,
  sections: [{ heading: "Context", markdown: "ctx" }, { heading: "Acceptance", markdown: "ok" }],
});

vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn(async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "list_ai_backlog" && env.failList) throw new Error("boom");
    if (cmd === "list_ai_backlog") return backlog;
    if (cmd === "read_ai_todo") return doc(args.id);
    if (cmd === "search_ai_todos") return env.search ?? { live_ids: [], archived: [], archived_truncated: false };
    return null;
  }),
}));
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => env.remote }));
vi.mock("../src/shared/open-file.ts", () => ({ openFileInApp: vi.fn() }));
vi.mock("../src/shared/chat/chat-transforms.ts", () => ({ renderMarkdown: (s) => `<p>${s}</p>` }));
vi.mock("../src/shared/chat/file-surface.ts", () => ({ markdownForDisplay: (s) => s }));
vi.mock("../src/views/sessions/sidebar.ts", () => ({ refreshSessions: vi.fn(async () => {}) }));
vi.mock("../src/views/sessions/session-controls.ts", () => ({ openChatById: vi.fn() }));
vi.mock("../src/views/sessions/state.ts", () => ({ state: { get sessions() { return env.sessions; } } }));

const { mountBacklogPanel } = await import("../src/views/sessions/backlog-panel/backlog-panel.ts");

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

async function mount() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const counts = [];
  const h = mountBacklogPanel(root, (n) => counts.push(n));
  h.setSessionScope("sess-1", "C:\\p");
  await flush();
  return { root, h, counts };
}

beforeEach(() => {
  calls.length = 0;
  document.body.innerHTML = "";
  env.remote = false;
  env.failList = false;
  env.sessions = [{ session_id: "sess-1" }];
});

describe("Backlog panel", () => {
  it("lists the groups, reports the open count and opens the first todo's reader", async () => {
    const { root, counts } = await mount();
    expect(root.querySelectorAll(".bl-row")).toHaveLength(2);
    expect(root.querySelector(".bl-group-name").textContent).toBe("Release");
    expect(counts.at(-1)).toBe(2);
    expect(root.querySelector(".bl-doc-title").textContent).toBe("First");
    expect(root.querySelector(".bl-why")).not.toBeNull();
    expect(calls.find(([c]) => c === "read_ai_todo")[1]).toEqual({ cwd: "C:\\p", id: "pc-0001" });
  });

  it("shows the write footer on the desktop for a local chat", async () => {
    const { root } = await mount();
    expect(root.querySelector(".bl-actions")).not.toBeNull();
    expect(root.querySelector('[data-bl-act="start"]')).not.toBeNull();
    expect(root.querySelector(".bl-grip")).not.toBeNull();
  });

  it("hides the footer and the drag grips on the phone", async () => {
    env.remote = true;
    const { root } = await mount();
    expect(root.querySelector(".bl-doc-title").textContent).toBe("First");
    expect(root.querySelector(".bl-actions")).toBeNull();
    expect(root.querySelector(".bl-grip")).toBeNull();
    expect(root.querySelector(".bl-panel").hasAttribute("data-phone")).toBe(true);
  });

  it("hides the footer for a chat mirrored from a peer, and reads by session id", async () => {
    env.sessions = [{ session_id: "sess-1", machine: { id: "mac", label: "Mac" } }];
    const { root } = await mount();
    expect(root.querySelector(".bl-actions")).toBeNull();
    expect(calls.find(([c]) => c === "list_ai_backlog")[1]).toEqual({ cwd: "C:\\p", sessionId: "sess-1" });
    expect(calls.find(([c]) => c === "read_ai_todo")[1]).toEqual({ cwd: "C:\\p", id: "pc-0001", sessionId: "sess-1" });
  });

  it("disables Archive with the reason while a chat holds the claim", async () => {
    const { root } = await mount();
    root.querySelector('[data-bl-id="pc-0002"]').click();
    await flush();
    const btn = root.querySelector('[data-bl-act="archive"]');
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe("A chat is working on it");
  });

  it("remembers the chosen row per project while the panel lives", async () => {
    const { root, h } = await mount();
    root.querySelector('[data-bl-id="pc-0002"]').click();
    await flush();
    h.setSessionScope("sess-2", "C:\\q");
    await flush();
    h.setSessionScope("sess-1", "C:\\p");
    await flush();
    expect(root.querySelector(".bl-row.is-on").dataset.blId).toBe("pc-0002");
  });

  it("does not keep a todo asked for with no project, so a later scope does not jump to it", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const h = mountBacklogPanel(root);
    h.openTodo("pc-0002");
    h.setSessionScope("sess-1", "C:\\p");
    await flush();
    expect(root.querySelector(".bl-row.is-on").dataset.blId).toBe("pc-0001");
  });

  it("does not keep a todo asked for when the list fetch failed", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const h = mountBacklogPanel(root);
    env.failList = true;
    h.setSessionScope("sess-1", "C:\\p");
    h.openTodo("pc-0002");
    await flush();
    env.failList = false;
    h.refresh();
    await flush();
    expect(root.querySelector(".bl-row.is-on").dataset.blId).toBe("pc-0001");
  });

  it("says No todos when the project has none", async () => {
    const saved = backlog.todos.splice(0);
    try {
      const { root } = await mount();
      expect(root.querySelector(".bl-empty").hidden).toBe(false);
      expect(root.querySelector(".bl-panel").hasAttribute("data-empty")).toBe(true);
    } finally {
      backlog.todos.push(...saved);
    }
  });

  it("archives with the note, offers Undo, and Undo hands the record back", async () => {
    const record = { id: "pc-0001", done_path: "d", original_path: "o", original_content: "c", plan_line: null, plan_line_index: null };
    const ipc = await import("../src/shared/ipc.ts");
    const base = ipc.invoke.getMockImplementation();
    ipc.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "ai_todo_archive") { calls.push([cmd, args]); return record; }
      return base(cmd, args);
    });
    try {
      const { root } = await mount();
      root.querySelector('[data-bl-act="archive"]').click();
      root.querySelector(".bl-note").value = " not needed ";
      root.querySelector('[data-bl-act="archive-go"]').click();
      await flush();
      expect(calls.find(([c]) => c === "ai_todo_archive")[1]).toEqual({ cwd: "C:\\p", id: "pc-0001", note: "not needed" });
      expect(root.querySelector(".bl-toast").hidden).toBe(false);
      expect(root.querySelector(".bl-toast").textContent).toContain("Archived pc-0001");
      root.querySelector('[data-bl-act="undo"]').click();
      await flush();
      expect(calls.find(([c]) => c === "ai_todo_unarchive")[1]).toEqual({ cwd: "C:\\p", archived: record });
    } finally {
      ipc.invoke.mockImplementation(base);
    }
  });

  // The chat the user switched to must not inherit the old chat's reply: the
  // archive already ran on the backend, but a toast over the new project would
  // carry an Undo bound to the wrong cwd, which the backend refuses.
  describe("a chat switch while a backend call is in flight", () => {
    const other = { groups: [], todos: [{ ...backlog.todos[0], id: "pc-0009", name: "pc-0009-z.md", title: "Other project todo" }] };

    async function withHeldCall(cmd, result) {
      const ipc = await import("../src/shared/ipc.ts");
      const base = ipc.invoke.getMockImplementation();
      let release;
      const held = new Promise((r) => { release = () => r(result); });
      ipc.invoke.mockImplementation(async (c, args) => {
        if (c === cmd) { calls.push([c, args]); return held; }
        if (c === "list_ai_backlog" && args.cwd === "C:\q") return other;
        if (c === "read_ai_todo" && args.cwd === "C:\q") return { entry: other.todos[0], why: null, sections: [] };
        return base(c, args);
      });
      return { release, restore: () => ipc.invoke.mockImplementation(base) };
    }

    it("drops the archive reply: no toast, no Undo, the new chat's list stays", async () => {
      const record = { id: "pc-0001", done_path: "d", original_path: "o", original_content: "c", plan_line: null, plan_line_index: null };
      const { release, restore } = await withHeldCall("ai_todo_archive", record);
      try {
        const { root, h } = await mount();
        root.querySelector('[data-bl-act="archive"]').click();
        root.querySelector('[data-bl-act="archive-go"]').click();
        await flush();
        h.setSessionScope("sess-2", "C:\q");
        await flush();
        release();
        await flush();
        expect(root.querySelector(".bl-toast").hidden).toBe(true);
        expect(root.querySelector('[data-bl-act="undo"]')).toBeNull();
        expect([...root.querySelectorAll(".bl-row")].map((r) => r.dataset.blId)).toEqual(["pc-0009"]);
        expect(calls.some(([c]) => c === "ai_todo_unarchive")).toBe(false);
      } finally {
        restore();
      }
    });

    it("drops the start-chat reply: does not open the chat over the one the user moved to", async () => {
      const { release, restore } = await withHeldCall("ai_todo_start_chat", "new-sess");
      const controls = await import("../src/views/sessions/session-controls.ts");
      controls.openChatById.mockClear();
      try {
        const { root, h } = await mount();
        root.querySelector('[data-bl-act="start"]').click();
        await flush();
        h.setSessionScope("sess-2", "C:\q");
        await flush();
        release();
        await flush();
        expect(controls.openChatById).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it("still opens the started chat when the user stayed put", async () => {
      const { release, restore } = await withHeldCall("ai_todo_start_chat", "new-sess");
      const controls = await import("../src/views/sessions/session-controls.ts");
      controls.openChatById.mockClear();
      try {
        const { root } = await mount();
        root.querySelector('[data-bl-act="start"]').click();
        await flush();
        release();
        await flush();
        expect(controls.openChatById).toHaveBeenCalledWith("new-sess");
      } finally {
        restore();
      }
    });
  });

  async function overrideIpc(handler) {
    const ipc = await import("../src/shared/ipc.ts");
    const base = ipc.invoke.getMockImplementation();
    ipc.invoke.mockImplementation(async (cmd, args) => {
      const r = handler(cmd, args);
      return r === undefined ? base(cmd, args) : r;
    });
    return () => ipc.invoke.mockImplementation(base);
  }

  // Undo runs against the cwd it captured, but what it does AFTER the await
  // (select a row, show an error, refetch) acts on whatever chat is current.
  describe("Undo after a chat switch", () => {
    const record = { id: "pc-0001", done_path: "d", original_path: "o", original_content: "c", plan_line: null, plan_line_index: null };
    // The other project also has a pc-0001, listed second, so a stray select
    // of the old project's id would visibly move the reader onto it.
    const other = {
      groups: [],
      todos: ["pc-0009", "pc-0001"].map((id, i) => ({ ...backlog.todos[0], id, name: `${id}-z.md`, title: `Other ${id}`, group: null, plan_index: null, mtime_ms: 10 - i })),
    };

    async function archiveThenHoldUndo(unarchiveOutcome) {
      let settle;
      const held = new Promise((res, rej) => { settle = () => (unarchiveOutcome instanceof Error ? rej(unarchiveOutcome) : res(null)); });
      const restore = await overrideIpc((cmd, args) => {
        if (cmd === "ai_todo_archive") return record;
        if (cmd === "ai_todo_unarchive") { calls.push([cmd, args]); return held; }
        if (cmd === "list_ai_backlog" && args.cwd === "C:q") return other;
        if (cmd === "read_ai_todo" && args.cwd === "C:q") return { entry: other.todos.find((t) => t.id === args.id), why: null, sections: [] };
        return undefined;
      });
      const m = await mount();
      m.root.querySelector('[data-bl-act="archive"]').click();
      m.root.querySelector('[data-bl-act="archive-go"]').click();
      await flush();
      m.root.querySelector('[data-bl-act="undo"]').click();
      await flush();
      m.h.setSessionScope("sess-2", "C:\q");
      await flush();
      return { ...m, settle, restore };
    }

    it("does not select the restored todo in the project the user moved to", async () => {
      const { root, settle, restore } = await archiveThenHoldUndo(null);
      try {
        expect(root.querySelector(".bl-row.is-on").dataset.blId).toBe("pc-0009");
        settle();
        await flush();
        expect(calls.find(([c]) => c === "ai_todo_unarchive")[1].cwd).toBe("C:\\p");
        expect(root.querySelector(".bl-row.is-on").dataset.blId).toBe("pc-0009");
      } finally {
        restore();
      }
    });

    it("does not show a failed undo's error over the project the user moved to", async () => {
      const { root, settle, restore } = await archiveThenHoldUndo(new Error("refused"));
      try {
        settle();
        await flush();
        expect(root.querySelector(".bl-error").hidden).toBe(true);
      } finally {
        restore();
      }
    });

    it("still selects the restored todo when the user stayed put", async () => {
      const restore = await overrideIpc((cmd) => (cmd === "ai_todo_archive" ? record : undefined));
      try {
        const { root } = await mount();
        root.querySelector('[data-bl-act="archive"]').click();
        root.querySelector('[data-bl-act="archive-go"]').click();
        await flush();
        root.querySelector('[data-bl-act="undo"]').click();
        await flush();
        expect(root.querySelector(".bl-row.is-on").dataset.blId).toBe("pc-0001");
      } finally {
        restore();
      }
    });
  });

  // jsdom has no layout, so the drag helpers read rects stubbed per element.
  const pointer = (target, type, init) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, ...init }));
  function stackSections(root) {
    root.querySelectorAll(".bl-group").forEach((el, i) => {
      el.getBoundingClientRect = () => ({ top: i * 100, bottom: i * 100 + 100, height: 100, left: 0, right: 100, width: 100 });
    });
  }

  describe("dragging a group", () => {
    // PLAN.md lists A and B; X and Y exist only because todos name them.
    const withExtras = {
      groups: ["A", "B"],
      todos: ["A", "B", "X", "Y"].map((g, i) => ({ ...backlog.todos[0], id: `pc-01${i}`, name: `pc-01${i}.md`, title: `In ${g}`, group: g, plan_index: i })),
    };

    async function dragGroup(name, y) {
      const restore = await overrideIpc((cmd, args) => {
        if (cmd === "list_ai_backlog") return withExtras;
        if (cmd === "read_ai_todo") return { entry: withExtras.todos.find((t) => t.id === args.id), why: null, sections: [] };
        return undefined;
      });
      const { root } = await mount();
      stackSections(root);
      const head = root.querySelector(`.bl-group[data-group="${name}"] [data-bl-group-grab]`);
      pointer(head, "pointerdown", { clientX: 0, clientY: 0 });
      pointer(document, "pointermove", { clientX: 30, clientY: y });
      pointer(document, "pointerup", { clientX: 30, clientY: y });
      await flush();
      return restore;
    }

    it("orders a todo-only group among the groups the list shows, not just PLAN.md's", async () => {
      // Sections sit at A 0, B 100, X 200, Y 300: y=210 is above X's midpoint.
      const restore = await dragGroup("Y", 210);
      try {
        expect(calls.find(([c]) => c === "ai_todo_plan_reorder_groups")[1]).toEqual({ cwd: "C:\\p", groups: ["A", "B", "Y", "X"] });
      } finally {
        restore();
      }
    });

    it("sends nothing when the drop leaves the shown order unchanged", async () => {
      // Y is already last: the drop below every section is a no-op.
      const restore = await dragGroup("Y", 10000);
      try {
        expect(calls.some(([c]) => c === "ai_todo_plan_reorder_groups")).toBe(false);
      } finally {
        restore();
      }
    });
  });

  describe("a refetch that lands mid-drag", () => {
    it("is replayed when the drag is cancelled, so the list does not stay stale", async () => {
      let title = "First";
      const restore = await overrideIpc((cmd) => {
        if (cmd !== "list_ai_backlog") return undefined;
        return { groups: backlog.groups, todos: backlog.todos.map((t) => (t.id === "pc-0001" ? { ...t, title } : t)) };
      });
      try {
        const { root } = await mount();
        const row = root.querySelector('[data-bl-id="pc-0001"]');
        pointer(row, "pointerdown", { clientX: 0, clientY: 0 });
        pointer(document, "pointermove", { clientX: 30, clientY: 0 });
        expect(root.querySelector(".bl-list").classList.contains("is-reordering")).toBe(true);
        title = "Renamed while dragging";
        window.dispatchEvent(new Event("focus"));
        await flush();
        expect(root.querySelector('[data-bl-id="pc-0001"] .bl-title').textContent).toBe("First");
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await flush();
        expect(root.querySelector('[data-bl-id="pc-0001"] .bl-title').textContent).toBe("Renamed while dragging");
      } finally {
        restore();
      }
    });
  });
});

describe("Backlog search", () => {
  const archivedDoc = {
    entry: { name: "pc-1757-old.md", path: "C:\\p\\.claude\\todos\\done\\pc-1757-old.md", id: "pc-1757", title: "Finished long ago", summary: null, origin: "dev", todo_type: "task", worth: null, complexity: null, claimed: false, group: null, plan_index: null, mtime_ms: 9 },
    why: null,
    sections: [{ heading: "Goal", markdown: "It was done." }],
  };
  const type = async (root, value) => {
    const input = root.querySelector(".bl-search-input");
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 260));
    await flush();
  };
  const ids = (root) => [...root.querySelectorAll(".bl-row")].map((r) => r.dataset.blId);

  beforeEach(() => { env.search = null; });

  it("filters the list live by id, title and summary, and says so when nothing matches", async () => {
    const { root } = await mount();
    await type(root, "second");
    expect(ids(root)).toEqual(["pc-0002"]);
    await type(root, "SUM");
    expect(ids(root)).toEqual(["pc-0001"]);
    await type(root, "0001");
    expect(ids(root)).toEqual(["pc-0001"]);
    await type(root, "zzz");
    expect(ids(root)).toEqual([]);
    expect(root.querySelector(".bl-nomatch").textContent).toContain("zzz");
    expect(root.querySelector(".bl-empty").hidden).toBe(true);
  });

  it("adds todos the daemon found by body text", async () => {
    env.search = { live_ids: ["pc-0002"], archived: [], archived_truncated: false };
    const { root } = await mount();
    await type(root, "flux");
    expect(ids(root)).toEqual(["pc-0002"]);
    expect(calls.find(([c]) => c === "search_ai_todos")[1]).toEqual({ cwd: "C:\\p", query: "flux", includeArchived: true });
  });

  it("shows an archived hit marked as archived and opens it in the reader without a read", async () => {
    env.search = { live_ids: [], archived: [archivedDoc], archived_truncated: false };
    const { root } = await mount();
    await type(root, "1757");
    const row = root.querySelector('.bl-row.is-archived[data-bl-id="pc-1757"]');
    expect(row.textContent).toContain("archived");
    expect(root.querySelector(".bl-group.is-archived-group .bl-group-name").textContent).toBe("Archived");
    row.click();
    await flush();
    expect(root.querySelector(".bl-doc-title").textContent).toBe("Finished long ago");
    expect(root.querySelector(".bl-tag-archived")).not.toBeNull();
    expect(root.querySelector(".bl-actions")).toBeNull();
    expect(calls.some(([c, a]) => c === "read_ai_todo" && a.id === "pc-1757")).toBe(false);
  });

  it("leaves archived hits out when the switch is off, and asks the daemon without them", async () => {
    env.search = { live_ids: [], archived: [archivedDoc], archived_truncated: false };
    const { root } = await mount();
    await type(root, "1757");
    const sw = root.querySelector(".bl-search-arch-in");
    sw.checked = false;
    sw.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    await flush();
    expect(ids(root)).toEqual([]);
    expect(root.querySelector(".bl-nomatch").textContent).toContain("Include archived");
    expect(calls.filter(([c]) => c === "search_ai_todos").at(-1)[1].includeArchived).toBe(false);
  });

  it("Escape clears the box and brings the full list and the live reader back", async () => {
    env.search = { live_ids: [], archived: [archivedDoc], archived_truncated: false };
    const { root } = await mount();
    await type(root, "1757");
    root.querySelector('[data-bl-id="pc-1757"]').click();
    await flush();
    const input = root.querySelector(".bl-search-input");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(root.querySelector(".bl-search-input").value).toBe("");
    expect(ids(root)).toEqual(["pc-0001", "pc-0002"]);
    expect(root.querySelector(".bl-doc-title").textContent).toBe("First");
    expect(root.querySelector(".bl-tag-archived")).toBeNull();
  });

  it("the clear button empties the box", async () => {
    const { root } = await mount();
    await type(root, "second");
    expect(root.querySelector(".bl-search-clear").hidden).toBe(false);
    root.querySelector('[data-bl-act="search-clear"]').click();
    expect(ids(root)).toEqual(["pc-0001", "pc-0002"]);
    expect(root.querySelector(".bl-search-clear").hidden).toBe(true);
  });

  it("on the phone filters the list only: no daemon search and no archived switch", async () => {
    env.remote = true;
    const { root } = await mount();
    expect(root.querySelector(".bl-search-arch-in")).toBeNull();
    await type(root, "second");
    expect(ids(root)).toEqual(["pc-0002"]);
    expect(calls.some(([c]) => c === "search_ai_todos")).toBe(false);
  });

  it("a slash inside the panel focuses the box", async () => {
    const { root } = await mount();
    root.querySelector('[data-bl-id="pc-0001"]').focus();
    root.querySelector('[data-bl-id="pc-0001"]').dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(root.querySelector(".bl-search-input"));
  });
});
