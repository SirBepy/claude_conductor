import { describe, it, expect, vi, beforeEach } from "vitest";

// chat-renderer pulls in DOM APIs; install minimal shims for this suite.
beforeEach(() => {
  const makeEl = () => ({
    appendChild: () => {},
    addEventListener: () => {},
    classList: { add: () => {}, remove: () => {} },
    querySelector: () => null,
    querySelectorAll: () => [],
    innerHTML: "",
    textContent: "",
    firstElementChild: { classList: { add: () => {}, remove: () => {} } },
    parentElement: null,
    parentNode: null,
    insertBefore: () => {},
    replaceWith: () => {},
    prepend: () => {},
    remove: () => {},
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: 0,
  });
  globalThis.document = {
    createElement: () => makeEl(),
    createDocumentFragment: () => makeEl(),
  };
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} };
  globalThis.window = { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, location: { hash: "" } };
  globalThis.getComputedStyle = () => ({ overflowY: "auto" });
});

async function loadRenderer() {
  const mod = await import("../src/shared/chat/chat-renderer.ts");
  return mod.ChatRenderer;
}

function makeContainer() {
  return {
    innerHTML: "",
    dataset: {},
    appendChild: () => {},
    addEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    parentElement: null,
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: 0,
    prepend: () => {},
    insertBefore: () => {},
  };
}

describe("ChatRenderer — fileEdits index + callbacks", () => {
  it("captures Edit tool_use into fileEdits and fires onFileEditsChanged", async () => {
    const ChatRenderer = await loadRenderer();
    const r = new ChatRenderer(makeContainer());
    const cb = vi.fn();
    r.onFileEditsChanged = cb;
    r.handleEvent({ type: "tool_use", tool_name: "Edit", input: { file_path: "/x.ts", old_string: "a", new_string: "b" }, id: "1" }, { silent: true });
    expect(cb).toHaveBeenCalledTimes(1);
    const arg = cb.mock.calls[0][0];
    expect(arg).toHaveLength(1);
    expect(arg[0].basename).toBe("x.ts");
  });

  it("does NOT fire onFileEditsChanged for non-file tools", async () => {
    const ChatRenderer = await loadRenderer();
    const r = new ChatRenderer(makeContainer());
    const cb = vi.fn();
    r.onFileEditsChanged = cb;
    r.handleEvent({ type: "tool_use", tool_name: "Bash", input: { command: "ls" }, id: "1" }, { silent: true });
    expect(cb).not.toHaveBeenCalled();
  });

  it("fires onActivityUpdate with describing string for tool_use", async () => {
    const ChatRenderer = await loadRenderer();
    const r = new ChatRenderer(makeContainer());
    const cb = vi.fn();
    r.onActivityUpdate = cb;
    r.handleEvent({ type: "tool_use", tool_name: "Edit", input: { file_path: "/x.ts", old_string: "", new_string: "" }, id: "1" }, { silent: true });
    expect(cb).toHaveBeenCalledWith("Editing x.ts", false);
    r.handleEvent({ type: "tool_use", tool_name: "Read", input: { file_path: "/y.ts" }, id: "2" }, { silent: true });
    expect(cb).toHaveBeenLastCalledWith("Reading y.ts", false);
    r.handleEvent({ type: "tool_use", tool_name: "Bash", input: { command: "echo hello world from the shell please" }, id: "3" }, { silent: true });
    const last = cb.mock.lastCall[0];
    expect(last.startsWith("Running:")).toBe(true);
    expect(last.length).toBeLessThanOrEqual(60);
  });

  it("keeps the last tool action pinned across assistant_message (no clear)", async () => {
    const ChatRenderer = await loadRenderer();
    const r = new ChatRenderer(makeContainer());
    const cb = vi.fn();
    r.onActivityUpdate = cb;
    r.handleEvent({ type: "tool_use", tool_name: "Edit", input: { file_path: "/x.ts", old_string: "", new_string: "" }, id: "1" }, { silent: true });
    cb.mockClear();
    // The reply streaming/finishing must NOT clear the pinned action; it stays
    // visible until the next user_message resets the turn.
    r.handleEvent({ type: "assistant_message", content: [{ type: "text", text: "done" }], streaming: false }, { silent: true });
    expect(cb).not.toHaveBeenCalled();
  });
});
