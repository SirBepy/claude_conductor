// @vitest-environment jsdom

// todo 873: the daemon refuses a send into a still-mid-turn session rather
// than writing into the live child. Every caller must put those blocks on the
// held queue - a failed-send bubble or a toast would strand a message the user
// already committed to, for the 20 minutes the busy watchdog takes to fire.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock, toastMock, stateStub } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  toastMock: vi.fn(),
  stateStub: { heldMessages: null, renderer: null },
}));

vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: (...a) => toastMock(...a) }));
vi.mock("../src/views/sessions/state.ts", () => ({ state: stateStub }));

const { isSessionBusyError } = await import("../src/shared/session-busy.ts");
const { HeldMessages } = await import("../src/shared/chat/held-messages.ts");
const { sendWithFailureRecovery } = await import("../src/views/sessions/send-with-failure-recovery.ts");
const { sessionEvents } = await import("../src/shared/chat/event-store.ts");

const SESSION = "sess-busy";
const BLOCKS = [{ type: "text", text: "queue me instead of losing me" }];
// Verbatim shapes: the desktop's RPC error string, and the phone's 409 body.
const RPC_BUSY = new Error(
  "rpc error: code=-32006 message=SESSION_BUSY: session sess-busy is mid-turn - hold this message until the turn ends",
);
const HTTP_BUSY = new Error("SESSION_BUSY: session sess-busy is mid-turn - hold this message until the turn ends");

function optimisticEvent() {
  return { type: "user_message", content: BLOCKS, timestamp: BigInt(Date.now()) };
}

beforeEach(() => {
  invokeMock.mockReset();
  // The default covers add_held_message's round trip, which every stage fires.
  invokeMock.mockResolvedValue({ id: 1 });
  toastMock.mockReset();
  localStorage.clear();
  stateStub.heldMessages = new HeldMessages();
  stateStub.renderer = null;
});

describe("isSessionBusyError", () => {
  it("recognizes both transports' shapes and nothing else", () => {
    expect(isSessionBusyError(RPC_BUSY)).toBe(true);
    expect(isSessionBusyError(HTTP_BUSY)).toBe(true);
    expect(isSessionBusyError("SESSION_BUSY: raw string body")).toBe(true);
    expect(isSessionBusyError(new Error("session id x not found"))).toBe(false);
    expect(isSessionBusyError(new Error("daemon client not connected"))).toBe(false);
    expect(isSessionBusyError(undefined)).toBe(false);
  });
});

describe("sendWithFailureRecovery", () => {
  it("re-stages a mid-turn refusal onto the held queue, silently", async () => {
    invokeMock.mockRejectedValueOnce(RPC_BUSY);
    const ev = optimisticEvent();
    sessionEvents.pushSynthetic(SESSION, ev);

    await sendWithFailureRecovery(SESSION, "/tmp/x", BLOCKS, ev);

    expect(stateStub.heldMessages.hasItemsFor(SESSION)).toBe(true);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("still surfaces a genuine send failure", async () => {
    invokeMock.mockRejectedValueOnce(new Error("daemon client not connected"));
    const ev = optimisticEvent();
    sessionEvents.pushSynthetic(SESSION, ev);

    await sendWithFailureRecovery(SESSION, "/tmp/x", BLOCKS, ev);

    expect(stateStub.heldMessages.hasItemsFor(SESSION)).toBe(false);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });
});

describe("flushBackground", () => {
  it("puts the bundle back when the refused session is still mid-turn, without logging a failure", async () => {
    const held = new HeldMessages();
    held.stageFor(SESSION, BLOCKS);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await held.flushBackground(SESSION, () => Promise.reject(HTTP_BUSY));

    expect(held.hasItemsFor(SESSION)).toBe(true);
    // A handled re-stage, so it must not read as a failed background flush.
    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it("still logs a genuine background flush failure", async () => {
    const held = new HeldMessages();
    held.stageFor(SESSION, BLOCKS);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await held.flushBackground(SESSION, () => Promise.reject(new Error("boom")));

    expect(errorLog).toHaveBeenCalledTimes(1);
    errorLog.mockRestore();
  });
});
