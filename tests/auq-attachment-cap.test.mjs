// @vitest-environment jsdom
//
// Task 2 (Joe, 2026-08-14): per-draft byte cap on AUQ attachments. Uses
// application/pdf blobs to isolate it from downscaleImage's real-canvas path.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));
vi.mock("tauri-plugin-clipboard-api", () => ({
  hasFiles: vi.fn().mockResolvedValue(false),
  readFiles: vi.fn().mockResolvedValue([]),
}));

const { createAuqAttachments } = await import("../src/views/sessions/permission-modal/attachments.ts");
const { serializeQuestionDraft } = await import("../src/views/sessions/permission-modal/draft-persistence.ts");

function pdfBlob(bytes) {
  return new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
}

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue("C:\\fake\\path.pdf");
});

describe("AUQ attachments - per-draft byte cap", () => {
  it("accepts an attachment under the 8MB per-draft budget", async () => {
    const ctl = createAuqAttachments({ sessionId: "s1", supportsExtras: true, onChange: vi.fn() });
    const res = await ctl.attachBlob(pdfBlob(3 * 1024 * 1024), "a.pdf");
    expect(res).toBeNull();
    expect(ctl.attachments).toHaveLength(1);
  });

  it("rejects an attachment that would push the draft over the cap, leaving existing attachments untouched", async () => {
    const ctl = createAuqAttachments({ sessionId: "s1", supportsExtras: true, onChange: vi.fn() });
    await ctl.attachBlob(pdfBlob(6 * 1024 * 1024), "a.pdf");

    const res = await ctl.attachBlob(pdfBlob(3 * 1024 * 1024), "b.pdf");

    expect(res).toMatch(/8 MB/);
    expect(ctl.attachments).toHaveLength(1);
    expect(ctl.attachments[0].filename).toBe("a.pdf");
  });

  it("attachFromPath respects the same cap (file is already on disk, but not staged into the draft)", async () => {
    invokeMock.mockResolvedValue({
      path: "/tmp/x.pdf",
      mime: "application/pdf",
      base64: "A".repeat(12_000_000), // decodes to ~8.6MB, over the cap
    });
    const ctl = createAuqAttachments({ sessionId: "s1", supportsExtras: true, onChange: vi.fn() });

    const res = await ctl.attachFromPath("/tmp/x.pdf");

    expect(res).toMatch(/8 MB/);
    expect(ctl.attachments).toHaveLength(0);
  });

  it("handleAttachmentPaste surfaces the cap rejection message to its caller", async () => {
    const ctl = createAuqAttachments({ sessionId: "s1", supportsExtras: true, onChange: vi.fn() });
    await ctl.attachBlob(pdfBlob(7 * 1024 * 1024), "a.pdf");
    const file = new File([new Uint8Array(3 * 1024 * 1024)], "b.pdf", { type: "application/pdf" });
    const evt = new Event("paste");
    Object.defineProperty(evt, "clipboardData", {
      value: { items: [{ kind: "file", type: "application/pdf", getAsFile: () => file }], getData: () => "" },
    });

    const msg = await ctl.handleAttachmentPaste(evt);

    expect(msg).toMatch(/8 MB/);
    expect(ctl.attachments).toHaveLength(1);
  });
});

describe("AUQ attachments - draft-sync payload stays cheap", () => {
  it("what would be pushed to the daemon never carries base64 bytes, only path/mime/filename/size", async () => {
    const ctl = createAuqAttachments({ sessionId: "s1", supportsExtras: true, onChange: vi.fn() });
    await ctl.attachBlob(pdfBlob(1024), "a.pdf");

    const payload = serializeQuestionDraft({
      freeText: new Map(), selections: new Map(), activeTab: 0, additionalMessage: "",
      attachments: ctl.attachments,
    });

    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0]).not.toHaveProperty("data");
    expect(payload.attachments[0].size).toBeGreaterThan(0);
  });
});
