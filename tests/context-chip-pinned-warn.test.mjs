// @vitest-environment jsdom
//
// The "[ctx-100]" diagnostic belongs to the status bar's own render. The
// Subchats card draws the same chip through contextChipHtml once a second while a
// pinned sub's details are open, so the builder itself must stay silent.

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => null) }));

const { contextChipHtml, renderContext } = await import("../src/views/sessions/statusbar-chips.ts");

const status = (pct_used) => ({ model: "claude-opus-5", window: 1_000_000, occupancy: Math.round(pct_used * 10_000), remaining: 0, pct_used, pct_left: 0, confidence: "proven" });

afterEach(() => vi.restoreAllMocks());

describe("pinned-at-100% context warning", () => {
  it("the shared chip builder never warns, however often a card redraws it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let tick = 0; tick < 3; tick++) expect(contextChipHtml(status(100), false)).toContain("100%");
    expect(warn).not.toHaveBeenCalled();
  });

  it("the status bar's render warns once per render of a pinned context, and not below 100", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const at = (pct) => ({ ctxStatus: status(pct), animatedKeys: new Set() });
    renderContext(false, at(99));
    expect(warn).not.toHaveBeenCalled();
    renderContext(false, at(100));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("[ctx-100]");
  });
});
