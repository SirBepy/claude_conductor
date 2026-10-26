// @vitest-environment jsdom

// A send refused because the chat's API-credit account is used up or at its
// Console spend limit must read as the bare reason, and must NOT go to the held
// queue (SESSION_BUSY does; here nothing frees by waiting for the turn to end).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock, toastMock, stateStub } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  toastMock: vi.fn(),
  stateStub: { heldMessages: null, renderer: null },
}));

vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: (...a) => toastMock(...a) }));
vi.mock("../src/views/sessions/state.ts", () => ({ state: stateStub }));

const { apiCreditBlockedReason, sendFailureText } = await import("../src/shared/api-credit-blocked.ts");
const { HeldMessages } = await import("../src/shared/chat/held-messages.ts");
const { sendWithFailureRecovery } = await import("../src/views/sessions/send-with-failure-recovery.ts");
const { sessionEvents } = await import("../src/shared/chat/event-store.ts");

const SESSION = "sess-credit";
const BLOCKS = [{ type: "text", text: "do the thing" }];
const REASON = "API credit for this cycle is used up";
// Verbatim shapes: the desktop's RPC error string, and the phone's 402 body.
const RPC_BLOCKED = new Error(`rpc error: code=-32007 message=API_CREDIT_BLOCKED: ${REASON}`);
const HTTP_BLOCKED = new Error(`API_CREDIT_BLOCKED: ${REASON}`);

function optimisticEvent() {
  return { type: "user_message", content: BLOCKS, timestamp: BigInt(Date.now()) };
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ id: 1 });
  toastMock.mockReset();
  localStorage.clear();
  stateStub.heldMessages = new HeldMessages();
  stateStub.renderer = null;
});

describe("apiCreditBlockedReason", () => {
  it("strips the sentinel from both transports' shapes", () => {
    expect(apiCreditBlockedReason(RPC_BLOCKED)).toBe(REASON);
    expect(apiCreditBlockedReason(HTTP_BLOCKED)).toBe(REASON);
    expect(apiCreditBlockedReason(`API_CREDIT_BLOCKED: ${REASON}`)).toBe(REASON);
  });

  it("is null for any other failure", () => {
    expect(apiCreditBlockedReason(new Error("SESSION_BUSY: mid-turn"))).toBeNull();
    expect(apiCreditBlockedReason(new Error("daemon client not connected"))).toBeNull();
    expect(apiCreditBlockedReason(undefined)).toBeNull();
  });

  it("falls back to a plain sentence when the reason is empty", () => {
    expect(apiCreditBlockedReason(new Error("API_CREDIT_BLOCKED:"))).toMatch(/paused/);
  });
});

describe("sendFailureText", () => {
  it("is the bare reason for a block and the raw error otherwise", () => {
    expect(sendFailureText(RPC_BLOCKED)).toBe(REASON);
    expect(sendFailureText(new Error("boom"))).toBe("Error: boom");
  });
});

describe("sendWithFailureRecovery - API-credit refusal", () => {
  it("toasts the bare reason and does not queue the message", async () => {
    invokeMock.mockRejectedValueOnce(RPC_BLOCKED);
    const ev = optimisticEvent();
    sessionEvents.pushSynthetic(SESSION, ev);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await sendWithFailureRecovery(SESSION, "/tmp/x", BLOCKS, ev);

    expect(stateStub.heldMessages.hasItemsFor(SESSION)).toBe(false);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith(REASON);
    // An expected stop, not a fault: nothing is logged as a failed send.
    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it("marks the on-screen bubble failed with the bare reason as its detail", async () => {
    invokeMock.mockRejectedValueOnce(HTTP_BLOCKED);
    const markLastUserSendFailed = vi.fn();
    stateStub.renderer = { currentSessionId: () => SESSION, markLastUserSendFailed };
    const ev = optimisticEvent();
    sessionEvents.pushSynthetic(SESSION, ev);

    await sendWithFailureRecovery(SESSION, "/tmp/x", BLOCKS, ev);

    expect(markLastUserSendFailed).toHaveBeenCalledTimes(1);
    expect(markLastUserSendFailed.mock.calls[0][0]).toBe(REASON);
    expect(stateStub.heldMessages.hasItemsFor(SESSION)).toBe(false);
  });
});
