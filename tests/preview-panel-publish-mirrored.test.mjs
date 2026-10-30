// @vitest-environment jsdom
// Publish to claude.ai reads the LOCAL preview store. A chat mirrored from a
// paired machine keeps its previews on that machine, so its More options menu
// must not offer Publish; a chat hosted here still does.
import { describe, it, expect, vi, afterEach } from "vitest";

const meta = (sid) => ({ id: `p-${sid}`, slug: "mock", title: "Mock", source: "chat_card", session_id: sid, version: 1, created_at: "2026-10-23T00:00:00.000Z" });
vi.mock("../src/shared/ipc", () => ({
  invoke: (cmd, args) => {
    if (cmd === "list_previews") return Promise.resolve([meta(args.sessionId)]);
    if (cmd === "get_preview") return Promise.resolve({ ...meta(args.sessionId), html: "<p>hi</p>" });
    if (cmd === "render_preview_doc") return Promise.resolve("about:blank");
    if (cmd === "list_slash_commands") return Promise.resolve([]);
    return Promise.resolve(undefined);
  },
}));
vi.mock("../src/shared/transport", () => ({
  getTransport: () => ({ listen: () => Promise.resolve(() => {}) }),
  isRemote: () => false,
}));

const { mountPreviewTab } = await import("../src/views/sessions/preview-panel.ts");
const { state } = await import("../src/views/sessions/state.ts");
const { closePvMoreMenu } = await import("../src/views/sessions/preview-panel-more-menu.ts");

let tab = null;
afterEach(() => {
  closePvMoreMenu();
  tab?.destroy();
  document.body.innerHTML = "";
});

async function openMoreMenu(sessionId) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  tab = mountPreviewTab(root, { isOpen: () => true, isVisible: () => true, requestOpen() {}, markOpenFor() {} });
  tab.setSessionScope(sessionId);
  await vi.waitFor(() => expect(root.querySelector(".pv-name")?.textContent).not.toBe("No previews yet"));
  root.querySelector('[data-act="more"]').click();
  await vi.waitFor(() => expect(document.querySelector(".smore-item")).not.toBeNull());
}

describe("Publish in the preview More options menu", () => {
  it("is offered for a chat hosted here", async () => {
    state.sessions = [{ session_id: "here", machine: null }];
    await openMoreMenu("here");
    expect(document.querySelector("[data-publish]")).not.toBeNull();
  });

  it("is not offered for a chat mirrored from a paired machine", async () => {
    state.sessions = [{ session_id: "on-mac", machine: { id: "m1", label: "Mac", online: true } }];
    await openMoreMenu("on-mac");
    expect(document.querySelector("[data-publish]")).toBeNull();
  });
});
