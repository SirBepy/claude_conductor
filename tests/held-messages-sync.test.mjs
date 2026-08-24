import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";

const { addHeldMessage, updateHeldMessage, removeHeldMessage, clearHeldMessages, getSessionDrafts } = vi.hoisted(() => ({
  addHeldMessage: vi.fn(),
  updateHeldMessage: vi.fn(),
  removeHeldMessage: vi.fn(),
  clearHeldMessages: vi.fn(),
  getSessionDrafts: vi.fn(),
}));

vi.mock("../src/shared/chat/session-draft-sync.ts", () => ({
  addHeldMessage: (...a) => addHeldMessage(...a),
  updateHeldMessage: (...a) => updateHeldMessage(...a),
  removeHeldMessage: (...a) => removeHeldMessage(...a),
  clearHeldMessages: (...a) => clearHeldMessages(...a),
  getSessionDrafts: (...a) => getSessionDrafts(...a),
}));

const { HeldMessages } = await import("../src/shared/chat/held-messages.ts");

function textBlocks(s) {
  return [{ type: "text", text: s }];
}

function makeHarness() {
  const anchor = document.createElement("div");
  anchor.className = "session-thinking";
  const chipSlot = document.createElement("span");
  chipSlot.className = "held-chip-slot";
  anchor.appendChild(chipSlot);
  document.body.appendChild(anchor);

  const send = vi.fn(async () => {});
  const interrupt = vi.fn(async () => {});
  const held = new HeldMessages();
  const attach = {
    sessionId: "sess-A",
    chipSlot,
    anchor,
    send,
    interrupt,
    getDraftBlocks: () => [],
    isDraftEmpty: () => true,
    isComposing: () => false,
    clearComposer: vi.fn(),
    getIsBusy: () => true,
    onChange: () => held.renderChip(),
  };
  held.attach(attach);
  return { held, attach, send };
}

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  addHeldMessage.mockReset().mockResolvedValue({ id: 1, updated_at: "t" });
  updateHeldMessage.mockReset().mockResolvedValue({ updated_at: "t" });
  removeHeldMessage.mockReset().mockResolvedValue({ updated_at: "t" });
  clearHeldMessages.mockReset().mockResolvedValue({ updated_at: "t" });
  // attach() always kicks off a reconcile - default to "nothing on the
  // daemon yet" so it never races a test's own stage() with a wipe.
  getSessionDrafts.mockReset().mockResolvedValue({ composer: null, auq: null, held: [], held_updated_at: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("HeldMessages - server-assigned ids", () => {
  it("stage() adds locally with a temp id, then swaps to the server id on success", async () => {
    addHeldMessage.mockResolvedValue({ id: 999, updated_at: "t" });
    const { held } = makeHarness();

    held.stage(textBlocks("one"));
    const [localItem] = held.itemsForActive();
    expect(localItem.id).not.toBe(999);
    expect(addHeldMessage).toHaveBeenCalledWith("sess-A", textBlocks("one"));

    await vi.waitFor(() => expect(held.itemsForActive()[0]?.id).toBe(999));
  });

  it("keeps the local id when add_held_message fails (offline fallback)", async () => {
    addHeldMessage.mockRejectedValue(new Error("offline"));
    const { held } = makeHarness();

    held.stage(textBlocks("one"));
    const localId = held.itemsForActive()[0].id;

    await new Promise((r) => setTimeout(r, 10));
    expect(held.itemsForActive()[0]?.id).toBe(localId);
    expect(held.hasItemsForActive()).toBe(true);
  });
});

describe("HeldMessages - edit/remove push through to the daemon", () => {
  it("removeItem calls remove_held_message with the server id once the pending add resolves", async () => {
    addHeldMessage.mockResolvedValue({ id: 42, updated_at: "t" });
    const { held } = makeHarness();
    held.stage(textBlocks("one"));
    const localId = held.itemsForActive()[0].id;

    held.removeItem(localId);
    expect(held.hasItemsForActive()).toBe(false); // local removal is synchronous

    await vi.waitFor(() => expect(removeHeldMessage).toHaveBeenCalledWith("sess-A", 42));
  });

  it("editItem debounces update_held_message, and flushEditPush bypasses the wait", async () => {
    addHeldMessage.mockResolvedValue({ id: 7, updated_at: "t" });
    const { held } = makeHarness();
    held.stage(textBlocks("orig"));
    await vi.waitFor(() => expect(held.itemsForActive()[0]?.id).toBe(7));

    vi.useFakeTimers();
    held.editItem(7, "ed");
    held.editItem(7, "edi");
    held.editItem(7, "edit");
    expect(updateHeldMessage).not.toHaveBeenCalled();

    held.flushEditPush(7);
    expect(updateHeldMessage).toHaveBeenCalledTimes(1);
    expect(updateHeldMessage).toHaveBeenCalledWith("sess-A", 7, textBlocks("edit"));
  });
});

describe("HeldMessages - clear on flush", () => {
  it("sendNow clears the daemon's held list for the session", async () => {
    const { held } = makeHarness();
    held.stage(textBlocks("queued"));
    await held.sendNow();
    expect(clearHeldMessages).toHaveBeenCalledWith("sess-A");
  });
});

describe("HeldMessages - reconcile on attach", () => {
  it("replaces the local held set with the daemon's copy on attach", async () => {
    getSessionDrafts.mockResolvedValue({
      composer: null,
      auq: null,
      held: [{ id: 55, blocks: textBlocks("from another surface"), updated_at: "t" }],
      held_updated_at: "t",
    });
    const { held } = makeHarness();
    expect(held.hasItemsForActive()).toBe(false); // nothing locally yet

    await vi.waitFor(() => expect(held.hasItemsForActive()).toBe(true));
    expect(held.itemsForActive()).toEqual([{ id: 55, blocks: textBlocks("from another surface") }]);
  });

  it("degrades to the existing local set when get_session_drafts fails", async () => {
    getSessionDrafts.mockRejectedValue(new Error("command not found"));
    const { held } = makeHarness();
    held.stage(textBlocks("local only"));
    await new Promise((r) => setTimeout(r, 10));
    expect(held.hasItemsForActive()).toBe(true);
  });
});
