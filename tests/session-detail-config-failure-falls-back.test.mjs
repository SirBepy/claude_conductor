// @vitest-environment jsdom

// Todo 1001, caller-change half: session-detail.ts's enrichHistorical already
// had a try/catch around api.getSessionConfig() (like backfillTranscripts's
// caller), but it was unreachable because getSessionConfig used to swallow a
// failed get_session_config call to null - identical to "no config recorded".
// That fed the model/effort inheritance a silent (wrong) result instead of
// falling back to the transcript-derived model. Now that getSessionConfig
// rejects on failure, prove the decision it feeds (which model/effort to
// show) is NOT taken from the failed read: model falls back to the
// transcript's own model, and effort is left unset rather than defaulted.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));

const { renderSessionDetailView } = await import("../src/views/session-detail/session-detail.ts");
const { setCurrentSessionRecord } = await import("../src/shared/state.ts");

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  invokeMock.mockReset();
  document.body.innerHTML = "";
});

describe("session-detail enrichHistorical - a failed config read does not drive the shown model/effort", () => {
  it("falls back to the transcript-derived model and no effort when get_session_config rejects", async () => {
    invokeMock.mockImplementation((command) => {
      if (command === "list_history") return Promise.resolve([]);
      if (command === "transcript_stats") {
        return Promise.resolve({ messages: 5, model: "claude-sonnet-4-5" });
      }
      if (command === "get_session_config") {
        return Promise.reject(new Error("backend unreachable"));
      }
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    // Historical (non-live): sessionId set, no `kind` -> isLive() is false.
    setCurrentSessionRecord({ sessionId: "hist-1", startedAt: "2024-01-01T00:00:00Z" });

    const root = document.createElement("div");
    document.body.appendChild(root);
    await renderSessionDetailView(root);
    // enrichHistorical is fired with `void` (not awaited); let its
    // microtasks (transcript_stats + get_session_config + re-render) settle.
    await flush();
    await flush();

    const body = document.getElementById("session-detail-body");
    expect(body.innerHTML).toContain("sonnet"); // transcript-derived model, not a config default
    expect(body.innerHTML).not.toContain("Effort"); // no config read -> no effort shown
  });

  it("uses the recorded config's model/effort when the read succeeds", async () => {
    invokeMock.mockImplementation((command) => {
      if (command === "list_history") return Promise.resolve([]);
      if (command === "transcript_stats") {
        return Promise.resolve({ messages: 5, model: "claude-sonnet-4-5" });
      }
      if (command === "get_session_config") {
        return Promise.resolve({ model: "claude-opus-4-8", effort: "high" });
      }
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    setCurrentSessionRecord({ sessionId: "hist-2", startedAt: "2024-01-01T00:00:00Z" });

    const root = document.createElement("div");
    document.body.appendChild(root);
    await renderSessionDetailView(root);
    await flush();
    await flush();

    const body = document.getElementById("session-detail-body");
    expect(body.innerHTML).toContain("opus");
    expect(body.innerHTML).toContain("Effort");
  });
});
