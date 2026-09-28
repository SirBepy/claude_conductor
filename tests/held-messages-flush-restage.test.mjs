import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";

// Todo 990: flush() and flushHeldWithDraft() used to clear the held map/
// server list and THEN call send(), with no rollback if send failed. Only
// flushBackground had the restage-on-failure pattern. These tests prove the
// same recovery now exists on the two paths that lacked it.
const { HeldMessages } = await import("../src/shared/chat/held-messages.ts");

function textBlocks(s) {
  return [{ type: "text", text: s }];
}

function makeHarness(overrides = {}) {
  const anchor = document.createElement("div");
  anchor.className = "session-thinking";
  const chipSlot = document.createElement("span");
  chipSlot.className = "held-chip-slot";
  anchor.appendChild(chipSlot);
  document.body.appendChild(anchor);

  const send = vi.fn(async () => {});
  const interrupt = vi.fn(async () => {});
  const state = { draftBlocks: [], draftEmpty: true, composing: false, busy: true };
  const held = new HeldMessages();
  const attach = {
    sessionId: "sess-A",
    chipSlot,
    anchor,
    send,
    interrupt,
    getDraftBlocks: () => state.draftBlocks,
    isDraftEmpty: () => state.draftEmpty,
    isComposing: () => state.composing,
    clearComposer: vi.fn(),
    getIsBusy: () => state.busy,
    onChange: () => held.renderChip(),
    ...overrides,
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
});

describe("HeldMessages - flush() restages on a failed send", () => {
  it("keeps the bundle staged (not lost) when send rejects", async () => {
    const { held, send, state } = makeHarness();
    send.mockImplementation(async () => { throw new Error("network exploded"); });
    held.stage(textBlocks("alpha"));
    state.busy = false;

    held.onCompletion("sess-A", false); // routes through the private flush()
    await new Promise((r) => setTimeout(r, 0));

    expect(send).toHaveBeenCalledTimes(1);
    // The failed send did not leave the bundle lost: it's staged again.
    expect(held.hasItemsForActive()).toBe(true);
  });

  it("restages even for a SESSION_BUSY rejection (the retriable case)", async () => {
    const { held, send, state } = makeHarness();
    send.mockImplementation(async () => { throw new Error("SESSION_BUSY: still running"); });
    held.stage(textBlocks("beta"));
    state.busy = false;

    held.onCompletion("sess-A", false);
    await new Promise((r) => setTimeout(r, 0));

    expect(held.hasItemsForActive()).toBe(true);
  });
});

describe("HeldMessages - flushHeldWithDraft() restages on a failed send", () => {
  it("keeps the bundled held+draft content staged when send rejects", async () => {
    const { held, send } = makeHarness();
    send.mockImplementation(async () => { throw new Error("send failed"); });
    held.stage(textBlocks("held-1"));

    const ok = await held.flushHeldWithDraft(textBlocks("draft-1"));

    // Still reports "handled" (not the "no attached controller" false) -
    // the composer must not also hand the draft text back, which would
    // duplicate it against the restaged held item.
    expect(ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(held.hasItemsForActive()).toBe(true);
  });
});
