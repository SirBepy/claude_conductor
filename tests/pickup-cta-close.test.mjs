// asserts: src/views/sessions/active-session.ts
// @vitest-environment jsdom
// The "Close & start new chat with /pickup" button closes the chat through the
// app's own close path (clear_session), sends it no /close message, and then
// launches the new chat with /pickup.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn(async () => undefined) }));

vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
vi.mock("../src/views/sessions/new-chat-config.ts", () => ({
  resolveNewChatConfig: vi.fn(async () => ({ model: "sonnet" })),
}));

const { state } = await import("../src/views/sessions/state.ts");
await import("../src/views/sessions/active-session.ts");
const { getCta } = await import("../src/shared/chat/cta-registry.ts");

describe("the /pickup button", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async () => undefined);
  });

  it("closes the chat through clear_session, sends no message, then launches /pickup", async () => {
    const sendText = vi.fn();
    const launch = vi.fn();
    state.sessions = [{ session_id: "s1", cwd: "C:/repo", busy: false, ended_at: null }];
    state.selectedId = "s1";
    state.composer = { sendText };
    state.launchNewChatCallback = launch;

    await getCta("pickup").handler();

    expect(invokeMock).toHaveBeenCalledWith("clear_session", { sessionId: "s1" });
    expect(sendText).not.toHaveBeenCalled();
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "send_message")).toBe(false);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0][1]).toMatchObject({ initialMessage: "/pickup" });
    expect(invokeMock.mock.invocationCallOrder[0]).toBeLessThan(launch.mock.invocationCallOrder[0]);
  });
});
