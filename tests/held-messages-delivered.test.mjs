// @vitest-environment jsdom
//
// markDelivered: the daemon injected a held message into a still-running turn
// (hooks_server::nudge / PostToolBatch) instead of waiting for the turn to end.
// The item is SENT at that point, so it has to leave the local queue - but
// unlike every other removal path it must NOT sync a remove back, because the
// daemon already dropped it from its own list.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";

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

  const held = new HeldMessages();
  const onChange = vi.fn(() => held.renderChip());
  const attachTo = (sessionId) =>
    held.attach({
      sessionId,
      chipSlot,
      anchor,
      send: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
      getDraftBlocks: () => [],
      isDraftEmpty: () => true,
      isComposing: () => false,
      clearComposer: vi.fn(),
      getIsBusy: () => true,
      onChange,
    });
  attachTo("sess-A");
  return { held, chipSlot, onChange, attachTo };
}

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
});

describe("markDelivered", () => {
  it("drops the delivered item and leaves the rest queued", () => {
    const { held } = makeHarness();
    held.stage(textBlocks("first"));
    held.stage(textBlocks("second"));
    const ids = held.itemsForActive().map((i) => i.id);

    held.markDelivered("sess-A", [ids[0]]);

    const left = held.itemsForActive();
    expect(left).toHaveLength(1);
    expect(left[0].blocks).toEqual(textBlocks("second"));
  });

  it("clears the chip once the last queued item is delivered", () => {
    const { held, chipSlot } = makeHarness();
    held.stage(textBlocks("only one"));
    expect(chipSlot.innerHTML).not.toBe("");

    held.markDelivered("sess-A", held.itemsForActive().map((i) => i.id));

    expect(held.itemsForActive()).toHaveLength(0);
    expect(chipSlot.innerHTML).toBe("");
  });

  it("is a no-op for ids that are not queued", () => {
    const { held, onChange } = makeHarness();
    held.stage(textBlocks("still mine"));
    onChange.mockClear();

    held.markDelivered("sess-A", [9999]);

    expect(held.itemsForActive()).toHaveLength(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  // A backgrounded chat can deliver a nudge too. Its chip is not on screen, but
  // the item still has to leave the queue or it gets sent a second time when
  // that session is next opened and flushed.
  it("drops items for a session that is not the attached one", () => {
    const { held, attachTo } = makeHarness();
    held.stageFor("sess-B", textBlocks("for the other chat"));
    attachTo("sess-B");
    const id = held.itemsForActive()[0].id;

    // Deliver while a DIFFERENT chat is the one on screen.
    attachTo("sess-A");
    held.markDelivered("sess-B", [id]);

    attachTo("sess-B");
    expect(held.itemsForActive()).toHaveLength(0);
  });
});
