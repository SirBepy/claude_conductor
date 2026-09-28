// Audit finding: api.backfillTranscripts() swallowed a failed backfill_transcripts
// call and returned {processed: 0, skipped: 0, ...} - indistinguishable from a
// real run that had nothing to do. The one caller (src/views/projects/projects.ts
// runBackfill) already has its own try/catch that shows a distinct "Error: ..."
// toast, so the fix is to stop swallowing here and let that catch do its job.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));

const { api } = await import("../src/shared/api.ts");

beforeEach(() => {
  invokeMock.mockReset();
});

describe("api.backfillTranscripts - failure is no longer disguised as a no-op", () => {
  it("rejects when the backend call fails, instead of resolving with a zeroed result", async () => {
    invokeMock.mockRejectedValue(new Error("backend unreachable"));
    await expect(api.backfillTranscripts()).rejects.toThrow("backend unreachable");
  });

  it("still resolves with the real counts on success", async () => {
    invokeMock.mockResolvedValue({ processed: 3, skipped: 1, subProcessed: 0, subSkipped: 0 });
    await expect(api.backfillTranscripts()).resolves.toEqual({
      processed: 3, skipped: 1, subProcessed: 0, subSkipped: 0,
    });
  });
});
