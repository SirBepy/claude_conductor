// @vitest-environment jsdom

// Pasting or attaching the same image twice leaves one chip.

import { describe, it, expect, vi } from "vitest";

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => "/tmp/x.png") }));
vi.mock("tauri-plugin-clipboard-api", () => ({ hasFiles: vi.fn(), readFiles: vi.fn() }));

import { ComposerAttachments } from "../src/shared/chat/composer-attachments.ts";

function make() {
  return new ComposerAttachments({ getSessionId: () => "s1", onChange: () => {} });
}

const png = (bytes) => new Blob([new Uint8Array(bytes)], { type: "image/png" });

describe("ComposerAttachments duplicate images", () => {
  it("drops a second paste of the same image", async () => {
    const c = make();
    await c.attachBlob(png([1, 2, 3]), "a.png");
    await c.attachBlob(png([1, 2, 3]), "b.png");
    expect(c.attachments).toHaveLength(1);
  });

  it("drops one of two identical images attached at once", async () => {
    const c = make();
    await Promise.all([c.attachBlob(png([1, 2, 3]), "a.png"), c.attachBlob(png([1, 2, 3]), "b.png")]);
    expect(c.attachments).toHaveLength(1);
  });

  it("keeps different images", async () => {
    const c = make();
    await c.attachBlob(png([1, 2, 3]), "a.png");
    await c.attachBlob(png([4, 5, 6]), "b.png");
    expect(c.attachments).toHaveLength(2);
  });
});
