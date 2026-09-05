import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";

const { HeldMessages, bundleHeld } = await import("../src/shared/chat/held-messages.ts");

function textBlocks(s) {
  return [{ type: "text", text: s }];
}

/** Build a controller wired to a jsdom-backed pane with spyable callbacks.
 * onChange re-renders the chip, mirroring updateThinkingBar in the real app. */
function makeHarness(overrides = {}) {
  const anchor = document.createElement("div");
  anchor.className = "session-thinking";
  const chipSlot = document.createElement("span");
  chipSlot.className = "held-chip-slot";
  anchor.appendChild(chipSlot);
  document.body.appendChild(anchor);

  const send = vi.fn(async () => {});
  const interrupt = vi.fn(async () => {});
  const state = {
    draftBlocks: [],
    draftEmpty: true,
    composing: false,
    busy: true,
  };
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
  return { held, attach, send, interrupt, state, anchor, chipSlot };
}

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
});

describe("bundleHeld", () => {
  it("joins each message's text with a blank line, in order", () => {
    const out = bundleHeld([textBlocks("first"), textBlocks("second"), textBlocks("third")]);
    expect(out).toEqual([{ type: "text", text: "first\n\nsecond\n\nthird" }]);
  });

  it("appends the trailing draft as the final message", () => {
    const out = bundleHeld([textBlocks("a")], textBlocks("draft"));
    expect(out).toEqual([{ type: "text", text: "a\n\ndraft" }]);
  });

  it("skips empty groups and returns [] when nothing has text", () => {
    expect(bundleHeld([textBlocks("   "), textBlocks("")])).toEqual([]);
  });
});

describe("HeldMessages — staging + chip", () => {
  it("stages messages and renders a pluralised count chip", () => {
    const { held, chipSlot } = makeHarness();
    expect(held.hasItemsForActive()).toBe(false);

    held.stage(textBlocks("one"));
    expect(held.hasItemsForActive()).toBe(true);
    held.renderChip();
    expect(chipSlot.querySelector(".held-count").textContent).toBe("1");
    expect(chipSlot.textContent).toContain("message waiting");

    held.stage(textBlocks("two"));
    held.renderChip();
    expect(chipSlot.querySelector(".held-count").textContent).toBe("2");
    expect(chipSlot.textContent).toContain("messages waiting");
  });

  it("keeps held sets separate per session", () => {
    const { held, attach } = makeHarness();
    held.stage(textBlocks("for-A"));
    // Re-attach as a different session: A's set must not leak into B.
    held.attach({ ...attach, sessionId: "sess-B" });
    expect(held.hasItemsForActive()).toBe(false);
  });
});

describe("HeldMessages — flush triggers", () => {
  it("auto-flushes a clean completion as one bundled message", () => {
    const { held, send } = makeHarness();
    held.stage(textBlocks("alpha"));
    held.stage(textBlocks("beta"));

    held.onCompletion("sess-A", /* isQuestion */ false);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith([{ type: "text", text: "alpha\n\nbeta" }]);
    expect(held.hasItemsForActive()).toBe(false);
  });

  it("does NOT auto-flush while Claude is asking a question", () => {
    const { held, send } = makeHarness();
    held.stage(textBlocks("alpha"));

    held.onCompletion("sess-A", /* isQuestion */ true);

    expect(send).not.toHaveBeenCalled();
    expect(held.hasItemsForActive()).toBe(true);
  });

  // An answer submitted while the asking turn was still finishing is refused
  // as SESSION_BUSY and staged; the turn's own `question` report then re-arms
  // the flag. The answer IS what the hold was waiting for, so it must go out.
  it("DOES auto-flush a held question answer even while flagged as asking", () => {
    const { held, send } = makeHarness();
    const answer = [{ type: "text", text: '<auq-answer id="card-1"/>Q: pick\nA: yes' }];
    held.stage(answer);
    expect(held.hasAuqAnswerFor("sess-A")).toBe(true);

    held.onCompletion("sess-A", /* isQuestion */ true);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(answer);
    expect(held.hasItemsForActive()).toBe(false);
  });

  it("hasAuqAnswerFor is false for plain prose", () => {
    const { held } = makeHarness();
    held.stage(textBlocks("just a note"));
    expect(held.hasAuqAnswerFor("sess-A")).toBe(false);
  });

  it("defers auto-flush while the user is composing, then fires when idle", () => {
    const { held, send, state } = makeHarness();
    held.stage(textBlocks("alpha"));
    state.composing = true;

    held.onCompletion("sess-A", false);
    expect(send).not.toHaveBeenCalled();

    // User stops typing and the session is idle -> deferred flush fires.
    state.composing = false;
    state.busy = false;
    held.notifyDraftActivity();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith([{ type: "text", text: "alpha" }]);
  });

  it("deferred flush fires on its own when the user just WAITS (no draft activity)", () => {
    vi.useFakeTimers();
    try {
      const { held, send, state } = makeHarness();
      held.stage(textBlocks("waited"));
      // Turn completes within the isComposing keystroke window (user staged then
      // sat still). The session is idle; they never touch the composer again.
      state.composing = true;
      state.busy = false;
      held.onCompletion("sess-A", false);
      expect(send).not.toHaveBeenCalled();

      // The 2s keystroke window lapses -> isComposing flips false. No blur/input
      // event fires, but the self-retry timer must still flush.
      state.composing = false;
      vi.advanceTimersByTime(2200);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith([{ type: "text", text: "waited" }]);
      expect(held.hasItemsForActive()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deferred retry keeps waiting while the user is still actively typing", () => {
    vi.useFakeTimers();
    try {
      const { held, send, state } = makeHarness();
      held.stage(textBlocks("queued"));
      state.composing = true;
      state.busy = false;
      held.onCompletion("sess-A", false);

      // Still typing one cycle later -> must NOT force-send.
      vi.advanceTimersByTime(2200);
      expect(send).not.toHaveBeenCalled();

      // They stop -> the next cycle flushes.
      state.composing = false;
      vi.advanceTimersByTime(2200);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith([{ type: "text", text: "queued" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Send now interrupts the turn, then sends held + draft as one", async () => {
    const { held, send, interrupt, state } = makeHarness();
    // The interrupt is cooperative: the turn's own trailing result line is what
    // clears busy, so model that rather than a child that never yields.
    interrupt.mockImplementation(async () => {
      state.busy = false;
    });
    held.stage(textBlocks("queued"));
    state.draftEmpty = false;
    state.draftBlocks = textBlocks("half-typed");

    await expect(held.sendNow()).resolves.toBe(true);

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith([{ type: "text", text: "queued\n\nhalf-typed" }]);
    expect(held.hasItemsForActive()).toBe(false);
  });

  it("Send now keeps the set held when the turn ignores the interrupt", async () => {
    vi.useFakeTimers();
    try {
      const { held, send, state } = makeHarness();
      state.busy = true; // the child never yields, so busy never clears

      held.stage(textBlocks("queued"));
      const pending = held.sendNow();
      await vi.advanceTimersByTimeAsync(21_000);

      await expect(pending).resolves.toBe(false);
      expect(send).not.toHaveBeenCalled();
      expect(held.hasItemsForActive()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushHeldWithDraft bundles the existing set with the draft", async () => {
    const { held, send } = makeHarness();
    held.stage(textBlocks("a"));
    held.stage(textBlocks("b"));

    await held.flushHeldWithDraft(textBlocks("c"));

    expect(send).toHaveBeenCalledWith([{ type: "text", text: "a\n\nb\n\nc" }]);
    expect(held.hasItemsForActive()).toBe(false);
  });
});

describe("HeldMessages — background flush (non-attached session)", () => {
  it("flushes a backgrounded session's held set via the injected sender", async () => {
    const { held, attach, send } = makeHarness();
    held.stage(textBlocks("alpha"));
    held.stage(textBlocks("beta"));
    // Switch away: sess-A's set stays behind while sess-B is mounted.
    held.attach({ ...attach, sessionId: "sess-B" });
    expect(held.hasItemsFor("sess-A")).toBe(true);

    const bgSend = vi.fn(async () => {});
    await held.flushBackground("sess-A", bgSend);

    expect(bgSend).toHaveBeenCalledTimes(1);
    expect(bgSend).toHaveBeenCalledWith([{ type: "text", text: "alpha\n\nbeta" }]);
    expect(held.hasItemsFor("sess-A")).toBe(false);
    // The mounted pane's sender must never fire for a backgrounded session.
    expect(send).not.toHaveBeenCalled();
  });

  it("no-ops when the session has nothing held", async () => {
    const { held, attach } = makeHarness();
    held.attach({ ...attach, sessionId: "sess-B" });

    const bgSend = vi.fn(async () => {});
    await held.flushBackground("sess-A", bgSend);

    expect(bgSend).not.toHaveBeenCalled();
  });

  it("never double-fires when the reselect flush races a slow background send", async () => {
    const { held, attach, send } = makeHarness();
    held.stage(textBlocks("queued"));
    held.attach({ ...attach, sessionId: "sess-B" });

    let resolveSend;
    const bgSend = vi.fn(() => new Promise((r) => { resolveSend = r; }));
    const inFlight = held.flushBackground("sess-A", bgSend);

    // Mid-send, the user switches back to sess-A and the reselect path fires:
    // the held set was cleared before the async send, so this must no-op.
    held.attach({ ...attach, sessionId: "sess-A" });
    held.onCompletion("sess-A", false);

    resolveSend();
    await inFlight;

    expect(bgSend).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("delegates to the attached path when the session is currently mounted", async () => {
    const { held, send } = makeHarness();
    held.stage(textBlocks("mine"));

    const bgSend = vi.fn(async () => {});
    await held.flushBackground("sess-A", bgSend);

    // The mounted pane owns its session (composing defer, draft bundling):
    // the injected sender must not bypass it.
    expect(bgSend).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith([{ type: "text", text: "mine" }]);
  });

  it("respects the composing defer when delegating to the attached path", async () => {
    vi.useFakeTimers();
    try {
      const { held, send, state } = makeHarness();
      held.stage(textBlocks("mid-typing"));
      state.composing = true;
      state.busy = false;

      const bgSend = vi.fn(async () => {});
      await held.flushBackground("sess-A", bgSend);

      expect(bgSend).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(held.hasItemsFor("sess-A")).toBe(true);

      // Once the keystroke window lapses, the deferred flush still fires.
      state.composing = false;
      vi.advanceTimersByTime(2200);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith([{ type: "text", text: "mid-typing" }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("HeldMessages — pending placeholder -> real id", () => {
  it("migrates a staged set so completion auto-flush matches the real id", () => {
    const { held, send, attach } = makeHarness({ sessionId: "pending-123" });
    held.stage(textBlocks("queued on placeholder"));

    // start_session resolved: placeholder upgrades to a real id.
    held.renameSession("pending-123", "real-abc");
    expect(held.hasItemsForActive()).toBe(true); // attached id followed the rename

    // The completion hook now fires under the REAL id and flushes.
    held.onCompletion("real-abc", false);
    expect(send).toHaveBeenCalledWith([{ type: "text", text: "queued on placeholder" }]);
    // Sanity: the placeholder no longer carries the set.
    held.attach({ ...attach, sessionId: "pending-123" });
    expect(held.hasItemsForActive()).toBe(false);
  });
});

describe("HeldMessages — editable dropdown rows", () => {
  it("drops a message when its row is cleared to empty and blurred", () => {
    const { held, chipSlot, anchor } = makeHarness();
    held.stage(textBlocks("keep"));
    held.stage(textBlocks("remove-me"));
    held.renderChip();

    // Expand the dropdown.
    chipSlot.querySelector(".held-chip").dispatchEvent(new window.Event("click"));
    const rows = anchor.querySelectorAll(".held-row");
    expect(rows.length).toBe(2);

    // Clear the second row and blur it -> the item is removed.
    rows[1].textContent = "";
    rows[1].dispatchEvent(new window.Event("blur"));

    expect(held.hasItemsForActive()).toBe(true);
    expect(chipSlot.querySelector(".held-count").textContent).toBe("1");
  });

  it("editing a row updates the text that gets bundled", () => {
    const { held, send, chipSlot, anchor } = makeHarness();
    held.stage(textBlocks("original"));
    held.renderChip();
    chipSlot.querySelector(".held-chip").dispatchEvent(new window.Event("click"));

    const row = anchor.querySelector(".held-row");
    row.textContent = "edited";
    row.dispatchEvent(new window.Event("input"));

    held.onCompletion("sess-A", false);
    expect(send).toHaveBeenCalledWith([{ type: "text", text: "edited" }]);
  });
});

describe("HeldMessages - popLastForActive (Ctrl+Z pop-back)", () => {
  it("pops the most recently staged item, LIFO", () => {
    const { held } = makeHarness();
    held.stage(textBlocks("first"));
    held.stage(textBlocks("second"));

    expect(held.popLastForActive()).toEqual(textBlocks("second"));
    expect(held.popLastForActive()).toEqual(textBlocks("first"));
    expect(held.popLastForActive()).toBeNull();
  });

  it("removes the popped item from the queue and updates the chip count", () => {
    const { held, chipSlot } = makeHarness();
    held.stage(textBlocks("keep"));
    held.stage(textBlocks("pop-me"));
    held.renderChip();

    held.popLastForActive();
    expect(held.hasItemsForActive()).toBe(true);
    expect(chipSlot.querySelector(".held-count").textContent).toBe("1");
  });

  it("returns null when nothing is queued", () => {
    const { held } = makeHarness();
    expect(held.popLastForActive()).toBeNull();
  });
});
