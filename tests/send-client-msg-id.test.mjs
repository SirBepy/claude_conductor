// @vitest-environment jsdom

// One id per message the user sends: the transport's own retry, the failed
// bubble's Retry button and the held-queue re-stage after a 409 all reuse it,
// so the PC delivers the message once. A different message gets a new id.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock, toastMock, stateStub } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  toastMock: vi.fn(),
  stateStub: { heldMessages: null, renderer: null },
}));

vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: (...a) => toastMock(...a) }));
vi.mock("../src/views/sessions/state.ts", () => ({ state: stateStub }));

const { HeldMessages } = await import("../src/shared/chat/held-messages.ts");
const { sendWithFailureRecovery } = await import("../src/views/sessions/send-with-failure-recovery.ts");
const { sessionEvents } = await import("../src/shared/chat/event-store.ts");

const SESSION = "sess-id";
const BLOCKS = [{ type: "text", text: "deliver me once" }];
const BUSY = new Error("SESSION_BUSY: session sess-id is mid-turn - hold this message until the turn ends");

function ev(blocks = BLOCKS) {
  const e = { type: "user_message", content: blocks, timestamp: BigInt(Date.now()) };
  sessionEvents.pushSynthetic(SESSION, e);
  return e;
}

function sendIds() {
  return invokeMock.mock.calls.filter((c) => c[0] === "send_message").map((c) => c[1].clientMsgId);
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ id: 1 });
  toastMock.mockReset();
  localStorage.clear();
  stateStub.heldMessages = new HeldMessages();
  stateStub.renderer = null;
});

describe("client message id", () => {
  it("rides every send_message call as clientMsgId", async () => {
    await sendWithFailureRecovery(SESSION, "/x", BLOCKS, ev());
    const [id] = sendIds();
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it("two different sends carry different ids", async () => {
    await sendWithFailureRecovery(SESSION, "/x", BLOCKS, ev());
    await sendWithFailureRecovery(SESSION, "/x", BLOCKS, ev());
    const [a, b] = sendIds();
    expect(a).not.toBe(b);
  });

  it("the Retry closure of a failed bubble re-sends with the original id", async () => {
    let retry;
    stateStub.renderer = {
      currentSessionId: () => SESSION,
      markLastUserSendFailed: (_detail, fn) => { retry = fn; },
    };
    invokeMock.mockRejectedValueOnce(new Error("send: could not reach your PC"));
    await sendWithFailureRecovery(SESSION, "/x", BLOCKS, ev());
    expect(retry).toBeTypeOf("function");
    invokeMock.mockResolvedValueOnce(SESSION);
    await retry();
    const [first, second] = sendIds();
    expect(second).toBe(first);
    expect(first).toBeTruthy();
  });

  it("a held-queue re-stage after a 409 keeps the id for the later delivery", async () => {
    invokeMock.mockRejectedValueOnce(BUSY);
    await sendWithFailureRecovery(SESSION, "/x", BLOCKS, ev());
    expect(stateStub.heldMessages.hasItemsFor(SESSION)).toBe(true);
    // The held flush sends the queued blocks through the same function.
    await sendWithFailureRecovery(SESSION, "/x", BLOCKS, ev());
    const [first, second] = sendIds();
    expect(second).toBe(first);
    // The id is spent once it went out: the next message is a new one.
    await sendWithFailureRecovery(SESSION, "/x", BLOCKS, ev());
    expect(sendIds()[2]).not.toBe(first);
  });

  it("a held message merged with other text is a new message and gets a new id", async () => {
    invokeMock.mockRejectedValueOnce(BUSY);
    await sendWithFailureRecovery(SESSION, "/x", BLOCKS, ev());
    const merged = [{ type: "text", text: "deliver me once\n\nand also this" }];
    await sendWithFailureRecovery(SESSION, "/x", merged, ev(merged));
    const [first, second] = sendIds();
    expect(second).not.toBe(first);
  });
});
