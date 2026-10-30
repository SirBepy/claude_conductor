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

  // pc-1479 (Joe, 2026-10-29): interrupting would kill the turn that just
  // received the injected item, so the rest waits for the turn to end instead.
  it("with one item injected and one still held, skips the interrupt and keeps the rest held for turn end", async () => {
    addHeldMessage.mockResolvedValueOnce({ id: 41, updated_at: "t" }).mockResolvedValueOnce({ id: 42, updated_at: "t" });
    clearHeldMessages.mockResolvedValue({ updated_at: "t", removed_ids: [42], injected_ids: [41] });
    const { held, send, interrupt } = makeHarness();
    // Once the survivor is re-pushed, the daemon's list (which sendNow re-reads on settling) holds it.
    getSessionDrafts.mockResolvedValue({ composer: null, auq: null, held: [{ id: 42, blocks: textBlocks("still-held"), updated_at: "t" }], held_updated_at: "t" });
    held.stage(textBlocks("already-in"));
    held.stage(textBlocks("still-held"));

    await expect(held.sendNow()).resolves.toBe(true);

    expect(interrupt).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(held.itemsForActive().map((i) => i.blocks)).toEqual([textBlocks("still-held")]);
    // The claim emptied the daemon's list, so the survivor is pushed back to it.
    await vi.waitFor(() => expect(addHeldMessage).toHaveBeenLastCalledWith("sess-A", textBlocks("still-held")));

    held.onCompletion("sess-A", false);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(textBlocks("still-held")));
  });

  it("flushes the rest right away when the turn ended while the claim was awaiting", async () => {
    addHeldMessage.mockResolvedValueOnce({ id: 41, updated_at: "t" }).mockResolvedValueOnce({ id: 42, updated_at: "t" });
    const { held, send, interrupt, state } = makeHarness();
    // The turn's completion lands during the claim round trip, before the branch runs.
    clearHeldMessages.mockImplementation(async () => {
      state.busy = false;
      return { updated_at: "t", removed_ids: [42], injected_ids: [41] };
    });
    held.stage(textBlocks("already-in"));
    held.stage(textBlocks("still-held"));

    await expect(held.sendNow()).resolves.toBe(true);

    expect(interrupt).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(textBlocks("still-held")));
    expect(held.hasItemsForActive()).toBe(false);
  });

  it("with an item injected and a non-empty draft, skips the interrupt and holds the draft for turn end", async () => {
    addHeldMessage.mockResolvedValue({ id: 41, updated_at: "t" });
    clearHeldMessages.mockResolvedValue({ updated_at: "t", removed_ids: [], injected_ids: [41] });
    const { held, attach, send, interrupt } = makeHarness();
    held.attach({ ...attach, isDraftEmpty: () => false, getDraftBlocks: () => textBlocks("typed draft") });
    // The staged draft reaches the daemon, whose list sendNow re-reads on settling.
    getSessionDrafts.mockResolvedValue({ composer: null, auq: null, held: [{ id: 41, blocks: textBlocks("typed draft"), updated_at: "t" }], held_updated_at: "t" });
    held.stage(textBlocks("already-in"));

    await expect(held.sendNow()).resolves.toBe(true);

    expect(interrupt).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(held.itemsForActive().map((i) => i.blocks)).toEqual([textBlocks("typed draft")]);
    expect(attach.clearComposer).toHaveBeenCalledTimes(1);
  });

  it("still interrupts when the daemon reports nothing injected", async () => {
    addHeldMessage.mockResolvedValue({ id: 42, updated_at: "t" });
    clearHeldMessages.mockResolvedValue({ updated_at: "t", removed_ids: [42], injected_ids: [] });
    const { held, send, interrupt } = makeHarness();
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

describe("HeldMessages - a failed add's unsynced mark stays with the item it describes", () => {
  // The mark is read in sendNow to mean "never reached the daemon, so it cannot
  // have been injected". A stale mark that matches a later item's id would make
  // that item look un-injected and send it a second time.
  it("does not carry a failed add in one session over to an injected item with the same id in another", async () => {
    const { held, attach, send, interrupt } = makeHarness();
    addHeldMessage.mockRejectedValueOnce(new Error("offline"));
    held.stage(textBlocks("never-reached-daemon"));
    const failedId = held.itemsForActive()[0].id;
    await new Promise((r) => setTimeout(r, 10));

    held.attach({ ...attach, sessionId: "sess-B" });
    addHeldMessage.mockResolvedValue({ id: failedId, updated_at: "t" });
    clearHeldMessages.mockResolvedValue({ updated_at: "t", removed_ids: [], injected_ids: [failedId] });
    held.stage(textBlocks("injected-in-B"));
    await new Promise((r) => setTimeout(r, 10));

    await expect(held.sendNow()).resolves.toBe(true);

    expect(interrupt).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  // pc-1483: the mark follows the item object, so a later item that the daemon
  // numbers with the failed item's local id is not mistaken for the failed one.
  it("does not mistake a later item whose server id equals a failed item's local id for the failed item", async () => {
    const { held, send, interrupt } = makeHarness();
    addHeldMessage.mockRejectedValueOnce(new Error("offline"));
    held.stage(textBlocks("never-reached-daemon"));
    const failedId = held.itemsForActive()[0].id;
    await new Promise((r) => setTimeout(r, 10));

    addHeldMessage.mockResolvedValue({ id: failedId, updated_at: "t" });
    held.stage(textBlocks("injected"));
    await new Promise((r) => setTimeout(r, 10));
    clearHeldMessages.mockResolvedValue({ updated_at: "t", removed_ids: [], injected_ids: [failedId] });

    await expect(held.sendNow()).resolves.toBe(true);

    // "injected" was delivered to the running turn, so no interrupt; the failed
    // item never reached the daemon and still waits for the turn to end.
    expect(interrupt).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(held.itemsForActive().map((i) => i.blocks)).toEqual([textBlocks("never-reached-daemon")]);
  });

  it("forgets a failed add once its item is removed", async () => {
    const { held, send, interrupt } = makeHarness();
    addHeldMessage.mockRejectedValueOnce(new Error("offline"));
    held.stage(textBlocks("dropped"));
    const failedId = held.itemsForActive()[0].id;
    await new Promise((r) => setTimeout(r, 10));
    held.removeItem(failedId);

    addHeldMessage.mockResolvedValue({ id: failedId, updated_at: "t" });
    clearHeldMessages.mockResolvedValue({ updated_at: "t", removed_ids: [], injected_ids: [failedId] });
    held.stage(textBlocks("injected"));
    await new Promise((r) => setTimeout(r, 10));

    await expect(held.sendNow()).resolves.toBe(true);

    expect(interrupt).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("forgets a failed add once the session's held list is flushed", async () => {
    const { held, send, interrupt, state } = makeHarness();
    addHeldMessage.mockRejectedValueOnce(new Error("offline"));
    clearHeldMessages.mockResolvedValue({ updated_at: "t", removed_ids: [] });
    held.stage(textBlocks("flushed"));
    const failedId = held.itemsForActive()[0].id;
    await new Promise((r) => setTimeout(r, 10));
    await expect(held.sendNow()).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);

    state.busy = true;
    interrupt.mockClear();
    send.mockClear();
    addHeldMessage.mockResolvedValue({ id: failedId, updated_at: "t" });
    clearHeldMessages.mockResolvedValue({ updated_at: "t", removed_ids: [], injected_ids: [failedId] });
    held.stage(textBlocks("injected"));
    await new Promise((r) => setTimeout(r, 10));

    await expect(held.sendNow()).resolves.toBe(true);

    expect(interrupt).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("HeldMessages - reconcile during sendNow", () => {
  it("does not wipe the local set when the chat is re-attached while sendNow waits for the turn to end", async () => {
    addHeldMessage.mockResolvedValue({ id: 41, updated_at: "t" });
    clearHeldMessages.mockResolvedValue({ updated_at: "t", removed_ids: [41], injected_ids: [] });
    const { held, attach, send, state } = makeHarness();
    // The turn ignores the interrupt until released, so sendNow sits in its poll.
    attach.interrupt.mockImplementation(async () => {});
    held.stage(textBlocks("queued"));

    const pending = held.sendNow();
    await new Promise((r) => setTimeout(r, 20));
    // The daemon's list is empty after the claim; attach() reconciles against it.
    held.attach({ ...attach });
    await new Promise((r) => setTimeout(r, 20));
    expect(held.itemsForActive().map((i) => i.blocks)).toEqual([textBlocks("queued")]);

    state.busy = false;
    await expect(pending).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith(textBlocks("queued"));
  });

  it("shows a held message added on the daemon during the wait once sendNow settles", async () => {
    addHeldMessage.mockResolvedValue({ id: 41, updated_at: "t" });
    clearHeldMessages.mockResolvedValue({ updated_at: "t", removed_ids: [41], injected_ids: [] });
    const { held, attach, state } = makeHarness();
    attach.interrupt.mockImplementation(async () => {});
    held.stage(textBlocks("queued"));

    const pending = held.sendNow();
    await new Promise((r) => setTimeout(r, 20));
    // Another surface stages a message mid-wait; this reconcile is suppressed.
    getSessionDrafts.mockResolvedValue({
      composer: null,
      auq: null,
      held: [{ id: 99, blocks: textBlocks("from phone"), updated_at: "t" }],
      held_updated_at: "t",
    });
    held.attach({ ...attach });
    await new Promise((r) => setTimeout(r, 20));
    expect(held.itemsForActive().map((i) => i.blocks)).toEqual([textBlocks("queued")]);

    state.busy = false;
    await expect(pending).resolves.toBe(true);
    await vi.waitFor(() => expect(held.itemsForActive().map((i) => i.blocks)).toEqual([textBlocks("from phone")]));
  });

  it("keeps reconcile suppressed when the session is renamed during the wait", async () => {
    addHeldMessage.mockResolvedValue({ id: 41, updated_at: "t" });
    clearHeldMessages.mockResolvedValue({ updated_at: "t", removed_ids: [41], injected_ids: [] });
    const { held, attach, send, state } = makeHarness();
    attach.interrupt.mockImplementation(async () => {});
    held.stage(textBlocks("queued"));

    const pending = held.sendNow();
    await new Promise((r) => setTimeout(r, 20));
    held.renameSession("sess-A", "sess-B");
    // The daemon's list for the new id is empty after the claim; attach() reconciles against it.
    held.attach({ ...attach, sessionId: "sess-B" });
    await new Promise((r) => setTimeout(r, 20));
    expect(held.itemsForActive().map((i) => i.blocks)).toEqual([textBlocks("queued")]);

    state.busy = false;
    await expect(pending).resolves.toBe(true);
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

describe("HeldMessages - sendNow's trailing reconcile", () => {
  it("logs a failed wait for the re-pushed adds instead of leaving an unhandled rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { held } = makeHarness();
    held.sync.addsSettled = () => Promise.reject(new Error("adds wait broke"));

    await held.sendNow();
    await new Promise((r) => setTimeout(r, 10));

    expect(warn).toHaveBeenCalledWith("[held] post-restage reconcile failed:", expect.any(Error));
    warn.mockRestore();
  });
});
