// @vitest-environment jsdom
// Switching chats while the Preview tab is on screen must not keep the
// previous chat's page up until the new chat's list_previews returns (a busy
// daemon during a cold chat load made that gap seconds long), and a reply for
// the chat Joe already left must never repaint the panel.
import { describe, it, expect, vi } from "vitest";

const pending = new Map();
const metaFor = (sid) => ({ id: `p-${sid}`, slug: `mock-${sid}`, title: sid, source: "chat_card", session_id: sid, version: 1, created_at: "2026-11-03T00:00:00.000Z" });
vi.mock("../src/shared/ipc", () => ({
  invoke: (cmd, args) => {
    if (cmd === "list_previews") {
      return new Promise((resolve) => pending.set(args.sessionId, () => resolve([metaFor(args.sessionId)])));
    }
    if (cmd === "get_preview") return Promise.resolve({ ...metaFor(args.sessionId), html: `<p>page-${args.sessionId}</p>` });
    if (cmd === "render_preview_doc") return Promise.resolve("about:blank");
    if (cmd === "list_slash_commands") return Promise.resolve([]);
    return Promise.resolve(undefined);
  },
}));
vi.mock("../src/shared/transport", () => ({
  getTransport: () => ({ listen: () => Promise.resolve(() => {}) }),
}));

const { mountPreviewTab } = await import("../src/views/sessions/preview-panel.ts");

function mount() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const tab = mountPreviewTab(root, { isOpen: () => true, isVisible: () => true, requestOpen() {}, markOpenFor() {} });
  return { root, tab };
}

describe("preview panel chat switch", () => {
  it("drops the previous chat's page while the new chat's list is in flight", async () => {
    const { root, tab } = mount();
    tab.setSessionScope("a");
    pending.get("a")();
    await vi.waitFor(() => expect(root.querySelector(".pv-name").textContent).toBe("mock-a"));

    tab.setSessionScope("b");
    expect(root.querySelector(".pv-name").textContent).toBe("");
    expect(root.querySelector(".pv-canvas").children.length).toBe(0);

    pending.get("b")();
    await vi.waitFor(() => expect(root.querySelector(".pv-name").textContent).toBe("mock-b"));
    tab.destroy();
  });

  it("ignores a list reply for a chat that was already left", async () => {
    const { root, tab } = mount();
    tab.setSessionScope("c");
    tab.setSessionScope("d");
    pending.get("d")();
    await vi.waitFor(() => expect(root.querySelector(".pv-name").textContent).toBe("mock-d"));

    pending.get("c")();
    await new Promise((r) => setTimeout(r, 20));
    expect(root.querySelector(".pv-name").textContent).toBe("mock-d");
    tab.destroy();
  });
});
