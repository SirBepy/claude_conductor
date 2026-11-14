// @vitest-environment jsdom
// asserts: src/views/sessions/backlog-panel/backlog-panel.ts

// The "Also due in <repo>" note belongs to the dashboard's Due highlight, so it
// shows even when this project's own backlog is empty: the todos it points at
// live in another repo of a group.

import { describe, it, expect, vi, beforeEach } from "vitest";

const env = { todos: [] };

vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn(async (cmd) => (cmd === "list_ai_backlog" ? { groups: [], todos: env.todos } : null)),
}));
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => false }));
vi.mock("../src/shared/open-file.ts", () => ({ openFileInApp: vi.fn() }));
vi.mock("../src/shared/chat/chat-transforms.ts", () => ({ renderMarkdown: (s) => `<p>${s}</p>` }));
vi.mock("../src/shared/chat/file-surface.ts", () => ({ markdownForDisplay: (s) => s }));
vi.mock("../src/views/sessions/sidebar.ts", () => ({ refreshSessions: vi.fn(async () => {}) }));
vi.mock("../src/views/sessions/session-controls.ts", () => ({ openChatById: vi.fn() }));
vi.mock("../src/views/sessions/state.ts", () => ({ state: { sessions: [] } }));

const { mountBacklogPanel } = await import("../src/views/sessions/backlog-panel/backlog-panel.ts");
const { setDueHighlight } = await import("../src/views/sessions/backlog-panel/due-highlight.ts");

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

async function mount() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const h = mountBacklogPanel(root);
  h.setSessionScope("sess-1", "C:\\p");
  await flush();
  return root;
}

beforeEach(() => {
  document.body.innerHTML = "";
  env.todos = [];
  setDueHighlight(null, []);
});

describe("Backlog panel due note", () => {
  it("paints the note for another repo's due todos when this backlog is empty", async () => {
    setDueHighlight("missed", [{ id: "pc-1", repo_cwd: "C:\\other" }]);
    const root = await mount();
    const note = root.querySelector(".bl-due-note");
    expect(note).not.toBeNull();
    expect(note.textContent).toContain("Also due in other (1)");
    expect(root.querySelector(".bl-list").hidden).toBe(false);
    expect(root.querySelector(".bl-empty").hidden).toBe(false);
  });

  it("paints nothing extra for an empty backlog with no highlight", async () => {
    const root = await mount();
    expect(root.querySelector(".bl-due-note")).toBeNull();
    expect(root.querySelector(".bl-list").hidden).toBe(true);
  });
});
