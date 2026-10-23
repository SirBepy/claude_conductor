// @vitest-environment jsdom
// A chat mirrored from a paired machine keeps its previews in that machine's
// store. The panel must name the chat on both reads: the daemon routes by it,
// and without it the local store (which holds none of that chat's previews)
// answers and the panel stays empty.
import { describe, it, expect, vi } from "vitest";

const calls = [];
const meta = { id: "p1", slug: "mock", title: "Mock", source: "chat_card", session_id: "chat-win", version: 1, created_at: "2026-10-23T00:00:00.000Z" };
vi.mock("../src/shared/ipc", () => ({
  invoke: (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "list_previews") return Promise.resolve([meta]);
    if (cmd === "get_preview") return Promise.resolve({ ...meta, html: "<p>hi</p>" });
    if (cmd === "render_preview_doc") return Promise.resolve("about:blank");
    if (cmd === "list_slash_commands") return Promise.resolve([]);
    return Promise.resolve(undefined);
  },
}));
vi.mock("../src/shared/transport", () => ({
  getTransport: () => ({ listen: () => Promise.resolve(() => {}) }),
}));

const { mountPreviewTab } = await import("../src/views/sessions/preview-panel.ts");

describe("preview panel session routing", () => {
  it("names the chat on list_previews and get_preview", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const tab = mountPreviewTab(root, {
      isOpen: () => true,
      isVisible: () => true,
      requestOpen() {},
      markOpenFor() {},
    });
    tab.setSessionScope("chat-win");
    await vi.waitFor(() => expect(calls.some((c) => c.cmd === "get_preview")).toBe(true));

    expect(calls.find((c) => c.cmd === "list_previews").args).toEqual({ sessionId: "chat-win" });
    expect(calls.find((c) => c.cmd === "get_preview").args).toEqual({ id: "p1", sessionId: "chat-win" });
    tab.destroy();
  });
});
