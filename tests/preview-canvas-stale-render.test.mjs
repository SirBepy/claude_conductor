// @vitest-environment jsdom
//
// Two quick renders into one canvas: the first render's late failure must not
// overwrite the second preview with its failure card.

import { describe, it, expect, vi } from "vitest";

const pending = [];
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn(() => new Promise((resolve, reject) => pending.push({ resolve, reject }))),
}));

const { mountPreviewStage } = await import("../src/views/sessions/preview-canvas.ts");

describe("mountPreviewStage", () => {
  it("a stale render that fails late leaves the newer preview on screen", async () => {
    const canvas = document.createElement("div");
    document.body.appendChild(canvas);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const first = mountPreviewStage(canvas, "desktop", "<p>one</p>");
    first.dispose();
    const second = mountPreviewStage(canvas, "desktop", "<p>two</p>");

    pending[1].resolve("http://127.0.0.1/doc/2");
    await second.ready;
    pending[0].reject(new Error("boom"));
    await first.ready;

    expect(canvas.querySelector(".pv-empty")).toBeNull();
    expect(canvas.querySelector(".pv-iframe")?.getAttribute("src")).toBe("http://127.0.0.1/doc/2");
    canvas.remove();
  });

  it("a current render that fails shows the failure card", async () => {
    const canvas = document.createElement("div");
    document.body.appendChild(canvas);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const only = mountPreviewStage(canvas, "desktop", "<p>x</p>");
    pending.at(-1).reject(new Error("boom"));
    await only.ready;

    expect(canvas.querySelector(".pv-empty")).not.toBeNull();
    canvas.remove();
  });
});
