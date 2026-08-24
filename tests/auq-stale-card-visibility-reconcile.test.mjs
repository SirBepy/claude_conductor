// @vitest-environment jsdom

// User-reported: a card stays shown on a backgrounded/asleep surface after
// being answered elsewhere - a diff-based poll only detects a resolve it was
// awake to observe. Fix: reconcile the CURRENT pending set on regaining
// visibility, instead of relying solely on having witnessed the removal.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn().mockResolvedValue([]) }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));

const { transportCall } = vi.hoisted(() => ({ transportCall: vi.fn() }));
vi.mock("../src/shared/transport.ts", () => ({
  getTransport: () => ({ call: (...a) => transportCall(...a), listen: vi.fn() }),
}));

const { installPermissionModalListener } = await import("../src/views/sessions/permission-modal/index.ts");
const { setActiveCard, clearActiveCardIfCurrent } = await import("../src/views/sessions/permission-modal/question-state.ts");
const { clearPendingPrompt, storePendingPrompt, peekPendingPrompt } = await import("../src/views/sessions/permission-modal/gating.ts");

function registerActiveCard(id, sessionId) {
  let torn = false;
  const teardown = () => { torn = true; clearActiveCardIfCurrent(teardown); };
  setActiveCard({ id, sessionId, teardown, getDraft: () => ({ freeText: new Map(), selections: new Map(), activeTab: 0, additionalMessage: "", attachments: [] }) });
  return { wasTornDown: () => torn };
}

beforeEach(() => {
  invokeMock.mockClear();
  transportCall.mockReset();
  setActiveCard(null);
  clearPendingPrompt("s1");
  window.__TAURI__ = undefined;
});

describe("regaining visibility reconciles a card the surface was asleep through", () => {
  it("dismisses the active card once the daemon's current pending set no longer contains it", async () => {
    installPermissionModalListener();
    const card = registerActiveCard("p1", "s1");
    // The daemon resolved it elsewhere while this surface was asleep/backgrounded -
    // no prompt-resolved event was ever witnessed here.
    transportCall.mockResolvedValue([]);

    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(card.wasTornDown()).toBe(true));
  });

  it("leaves the card alone if the daemon still lists it as pending", async () => {
    installPermissionModalListener();
    const card = registerActiveCard("p1", "s1");
    transportCall.mockResolvedValue([{ id: "p1", event: "question-requested", payload: { id: "p1" } }]);

    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 20));
    expect(card.wasTornDown()).toBe(false);
  });

  it("also clears a locally-parked (backgrounded, not on-screen) prompt that resolved while away", async () => {
    installPermissionModalListener();
    storePendingPrompt("s1", { kind: "question", payload: { id: "p2", session_id: "s1", questions: [] } });
    transportCall.mockResolvedValue([]);

    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(peekPendingPrompt("s1")).toBeNull());
  });
});
