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
    if (cmd === "list_ai_backlog") return backlog;
    if (cmd === "read_ai_todo") return doc(args.id);
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
});
