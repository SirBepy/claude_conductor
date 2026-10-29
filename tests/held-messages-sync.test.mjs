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
  const state = { busy: true };
  // sendNow waits for the turn to actually end (todo 873), so the interrupt
  // has to clear busy here or the poll never resolves.
  const interrupt = vi.fn(async () => {
    state.busy = false;
  });
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
    getIsBusy: () => state.busy,
    onChange: () => held.renderChip(),
  };
  held.attach(attach);
  return { held, attach, send, interrupt, state };
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

describe("HeldMessages - sendNow claims the daemon list before interrupting", () => {
  it("skips the interrupt and sends nothing when the daemon says the item was already injected mid-turn", async () => {
    addHeldMessage.mockResolvedValue({ id: 41, updated_at: "t" });
    clearHeldMessages.mockResolvedValue({ updated_at: "t", removed_ids: [] });
    const { held, send, interrupt } = makeHarness();
    held.stage(textBlocks("queued"));

    await expect(held.sendNow()).resolves.toBe(true);

    expect(interrupt).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(held.hasItemsForActive()).toBe(false);
  });

  it("matches removed_ids against the server id the add swapped in, even when sendNow races the add", async () => {
    let resolveAdd;
    addHeldMessage.mockReturnValue(new Promise((r) => { resolveAdd = r; }));
    clearHeldMessages.mockResolvedValue({ updated_at: "t", removed_ids: [77] });
    const { held, send, interrupt } = makeHarness();
    held.stage(textBlocks("queued"));

    const pending = held.sendNow();
    resolveAdd({ id: 77, updated_at: "t" });
    await expect(pending).resolves.toBe(true);

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(textBlocks("queued"));
  });

  it("interrupts then sends an item the daemon still held (removed_ids lists it)", async () => {
    addHeldMessage.mockResolvedValue({ id: 41, updated_at: "t" });
    clearHeldMessages.mockResolvedValue({ updated_at: "t", removed_ids: [41] });
    const { held, send, interrupt } = makeHarness();
    held.stage(textBlocks("queued"));

    await expect(held.sendNow()).resolves.toBe(true);

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(textBlocks("queued"));
  });

  it("drops the injected item but still interrupts and sends the rest", async () => {
    addHeldMessage.mockResolvedValueOnce({ id: 41, updated_at: "t" }).mockResolvedValueOnce({ id: 42, updated_at: "t" });
    clearHeldMessages.mockResolvedValue({ updated_at: "t", removed_ids: [42] });
    const { held, send, interrupt } = makeHarness();
    held.stage(textBlocks("already-in"));
    held.stage(textBlocks("still-held"));

    await expect(held.sendNow()).resolves.toBe(true);

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(textBlocks("still-held"));
  });

  it("with injected_ids reported, skips the interrupt only for a confirmed injection", async () => {
    addHeldMessage.mockResolvedValue({ id: 41, updated_at: "t" });
    clearHeldMessages.mockResolvedValue({ updated_at: "t", removed_ids: [], injected_ids: [41] });
    const { held, send, interrupt } = makeHarness();
    held.stage(textBlocks("queued"));

    await expect(held.sendNow()).resolves.toBe(true);

    expect(interrupt).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("sends an item the daemon neither removed nor injected (its held list was lost to a restart)", async () => {
    addHeldMessage.mockResolvedValue({ id: 41, updated_at: "t" });
    clearHeldMessages.mockResolvedValue({ updated_at: "t", removed_ids: [], injected_ids: [] });
    const { held, send, interrupt } = makeHarness();
    held.stage(textBlocks("queued"));

    await expect(held.sendNow()).resolves.toBe(true);

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(textBlocks("queued"));
  });

  it("treats an item whose add failed as not injected: it is sent", async () => {
    addHeldMessage.mockRejectedValue(new Error("offline"));
    clearHeldMessages.mockResolvedValue({ updated_at: "t", removed_ids: [] });
    const { held, send, interrupt } = makeHarness();
    held.stage(textBlocks("never-reached-daemon"));

    await expect(held.sendNow()).resolves.toBe(true);

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(textBlocks("never-reached-daemon"));
  });

  it("falls back to interrupt-then-flush when an older daemon returns no removed_ids", async () => {
    addHeldMessage.mockResolvedValue({ id: 41, updated_at: "t" });
    clearHeldMessages.mockResolvedValue({ updated_at: "t" });
    const { held, send, interrupt } = makeHarness();
    held.stage(textBlocks("queued"));

    await expect(held.sendNow()).resolves.toBe(true);

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(textBlocks("queued"));
  });

  it("falls back to the legacy path when clear_held_messages fails", async () => {
    addHeldMessage.mockResolvedValue({ id: 41, updated_at: "t" });
    clearHeldMessages.mockRejectedValue(new Error("down"));
    const { held, send, interrupt } = makeHarness();
    held.stage(textBlocks("queued"));

    await expect(held.sendNow()).resolves.toBe(true);

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(textBlocks("queued"));
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
