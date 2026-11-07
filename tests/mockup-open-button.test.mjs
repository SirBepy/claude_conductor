// @vitest-environment jsdom
// The header's "Mockup" button: hidden until the chat on screen has pushed a
// preview, then opens that chat's newest one in the panel. A sub read in place
// is its own chat here, so its previews belong to its own session_id.
import { describe, it, expect, vi, beforeEach } from "vitest";

const previews = [];
let pushListener = null;
const listArgs = [];
vi.mock("../src/shared/ipc", () => ({
  invoke: (cmd, args) => {
    if (cmd !== "list_previews") return Promise.resolve(undefined);
    listArgs.push(args);
    return Promise.resolve(previews);
  },
}));
vi.mock("../src/shared/transport", () => ({
  getTransport: () => ({
    listen: (_ev, cb) => {
      pushListener = cb;
      return Promise.resolve(() => { pushListener = null; });
    },
  }),
}));

const { mountMockupButton, newestPreviewOf } = await import("../src/views/sessions/mockup-open-button.ts");
const { state } = await import("../src/views/sessions/state.ts");

const meta = (id, session_id) => ({ id, slug: id, title: id, source: "chat_card", session_id, version: 1, created_at: "2026-11-05T00:00:00.000Z" });
const makeHeader = () => {
  const trailSlot = document.createElement("div");
  document.body.appendChild(trailSlot);
  return { trailSlot };
};

describe("mockup button", () => {
  beforeEach(() => {
    previews.length = 0;
    listArgs.length = 0;
    document.body.innerHTML = "";
    state.previewController = null;
  });

  it("picks the newest preview pushed by this chat, ignoring other chats' entries", () => {
    const list = [meta("other", "main"), meta("new", "sub"), meta("old", "sub")];
    expect(newestPreviewOf(list, "sub")?.id).toBe("new");
    expect(newestPreviewOf(list, "nobody")).toBeUndefined();
    expect(newestPreviewOf(undefined, "sub")).toBeUndefined();
  });

  it("scopes by family as the panel does: a main chat sees its subs' previews, a sub sees its family's", async () => {
    state.sessions = [
      { session_id: "main", name: "main" },
      { session_id: "sub", name: "sub", subchat_of: "main" },
      { session_id: "sub2", name: "sub2", subchat_of: "main" },
      { session_id: "other", name: "other" },
    ];
    try {
      const list = [meta("elsewhere", "other"), meta("from-sub", "sub2"), meta("shared", "main")];
      // The main chat's panel lists its sub's page, so its button must exist.
      expect(newestPreviewOf([meta("from-sub", "sub2")], "main")?.id).toBe("from-sub");
      // A sub read in place covers the whole family, newest first.
      expect(newestPreviewOf(list, "sub")?.id).toBe("from-sub");
      expect(newestPreviewOf([meta("elsewhere", "other")], "main")).toBeUndefined();
    } finally {
      state.sessions = [];
    }
  });

  it("a main chat's button appears on a live push from one of its subs", async () => {
    state.sessions = [{ session_id: "main", name: "main" }, { session_id: "sub", name: "sub", subchat_of: "main" }];
    try {
      const header = makeHeader();
      mountMockupButton(header, "main");
      const btn = header.trailSlot.querySelector(".mockup-open-btn");
      await vi.waitFor(() => expect(pushListener).toBeTypeOf("function"));
      pushListener({ snapshot: meta("x", "elsewhere") });
      expect(btn.hidden).toBe(true);
      pushListener({ snapshot: meta("x", "sub") });
      expect(btn.hidden).toBe(false);
    } finally {
      state.sessions = [];
    }
  });

  it("stays hidden for a chat with no preview and appears on its first live push", async () => {
    const header = makeHeader();
    mountMockupButton(header, "sub");
    const btn = header.trailSlot.querySelector(".mockup-open-btn");
    await vi.waitFor(() => expect(pushListener).toBeTypeOf("function"));
    expect(btn.hidden).toBe(true);
    pushListener({ snapshot: meta("x", "main") });
    expect(btn.hidden).toBe(true);
    pushListener({ snapshot: meta("x", "sub") });
    expect(btn.hidden).toBe(false);
  });

  it("is shown for a chat that already has one, and opens the newest in the panel", async () => {
    previews.push(meta("new", "sub"), meta("old", "sub"));
    const open = vi.fn();
    state.previewController = { open };
    const header = makeHeader();
    mountMockupButton(header, "sub");
    const btn = header.trailSlot.querySelector(".mockup-open-btn");
    await vi.waitFor(() => expect(btn.hidden).toBe(false));
    btn.click();
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith("new"));
  });

  it("a sub in view asks list_previews with its main chat's id, as the panel does, so a family page shows the button", async () => {
    state.sessions = [{ session_id: "main", name: "main" }, { session_id: "sub", name: "sub", subchat_of: "main" }];
    try {
      // The daemon matches owner == scope or a sub of scope: only the main id reaches the shared page.
      previews.push(meta("shared", "main"));
      const open = vi.fn();
      state.previewController = { open };
      const header = makeHeader();
      mountMockupButton(header, "sub");
      const btn = header.trailSlot.querySelector(".mockup-open-btn");
      await vi.waitFor(() => expect(btn.hidden).toBe(false));
      expect(listArgs[0]).toEqual({ sessionId: "main" });
      btn.click();
      await vi.waitFor(() => expect(open).toHaveBeenCalledWith("shared"));
      expect(listArgs.at(-1)).toEqual({ sessionId: "main" });
    } finally {
      state.sessions = [];
    }
  });

  it("mounting for another chat removes the previous chat's button and listener", async () => {
    const header = makeHeader();
    mountMockupButton(header, "a");
    await vi.waitFor(() => expect(pushListener).toBeTypeOf("function"));
    mountMockupButton(header, "b");
    expect(header.trailSlot.querySelectorAll(".mockup-open-btn")).toHaveLength(1);
  });
});
