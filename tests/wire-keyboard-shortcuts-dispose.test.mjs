// @vitest-environment jsdom
//
// wireKeyboardShortcuts' disposer must unregister every id it registered, or a
// remounted Chats view leaves the previous mount's handler (closed over a dead
// view) live in the shared shortcuts handler map.

import { describe, it, expect, vi } from "vitest";

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn().mockResolvedValue([]) }));
vi.mock("tauri-plugin-clipboard-api", () => ({
  hasFiles: vi.fn().mockResolvedValue(false),
  readFiles: vi.fn().mockResolvedValue([]),
}));

const shortcuts = await import("../src/shared/shortcuts.ts");
const { wireKeyboardShortcuts } = await import("../src/views/sessions/sessions-dom-wiring.ts");

describe("wireKeyboardShortcuts disposer", () => {
  it("unregisters every shortcut id the wiring registered", () => {
    const registered = [];
    const unregistered = [];
    const realRegister = shortcuts.register;
    const realUnregister = shortcuts.unregister;
    const reg = vi.spyOn(shortcuts, "register").mockImplementation((id, h) => {
      registered.push(id);
      realRegister(id, h);
    });
    const unreg = vi.spyOn(shortcuts, "unregister").mockImplementation((id) => {
      unregistered.push(id);
      realUnregister(id);
    });

    const dispose = wireKeyboardShortcuts(document.createElement("ul"));
    expect(registered).toContain("toggle-wrap-up-on-done");
    dispose();

    expect(unregistered.sort()).toEqual([...registered].sort());
    reg.mockRestore();
    unreg.mockRestore();
  });
});
