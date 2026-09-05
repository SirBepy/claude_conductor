// @vitest-environment jsdom
//
// The model/effort sliders can be opened from two surfaces now: the statusline
// chip, and the pane header's config text (which lives OUTSIDE the statusbar's
// container). render() rebuilds every chip, so the two need opposite treatment -
// re-bind the chip one by selector, reposition the header one in place - and
// getting that split wrong closes a slider the user is still dragging on the
// next background refresh.

import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMock = { impl: async () => null };
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn((cmd, args) => ipcMock.impl(cmd, args)),
}));

const { SessionStatusbar } = await import("../src/views/sessions/session-statusbar.ts");
const { metaCache } = await import("../src/views/sessions/session-statusbar-helpers.ts");

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function mount(rows = [["model", "effort"]]) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const sb = new SessionStatusbar(el, null, rows, {
    sessionId: "sess-1",
    sessionModel: "claude-opus-5",
    effort: "high",
    hideZero: true,
  });
  return { el, sb };
}

const popover = (kind) => document.querySelector(`.sb-${kind}-popover`);

/** A background refresh: any meta/git/counts update lands here in real use. */
function rerender(sb) {
  sb.updateMeta({ model: "claude-opus-5", inputTokens: 1, hasThinking: false, totalCostUsd: 0, hasUsage: true });
}

beforeEach(() => {
  metaCache.clear();
  ipcMock.impl = async () => null;
  document.body.innerHTML = "";
});

describe("model/effort popover survives a statusbar re-render", () => {
  it("keeps a chip-opened effort slider open and re-binds it to the rebuilt chip", async () => {
    const { el, sb } = mount();
    await flush();

    el.querySelector(".sb-effort-btn").click();
    expect(popover("effort")).not.toBeNull();

    rerender(sb);

    expect(popover("effort")).not.toBeNull();
    // The chip the popover was opened from is gone; the rebuilt one is its anchor.
    expect(el.querySelector(".sb-effort-btn")).not.toBeNull();
  });

  it("keeps a chip-opened model slider open across the same re-render", async () => {
    const { el, sb } = mount();
    await flush();

    el.querySelector(".sb-model-btn").click();
    expect(popover("model")).not.toBeNull();

    rerender(sb);

    expect(popover("model")).not.toBeNull();
  });

  it("keeps a header-anchored slider open, since that anchor is never rebuilt", async () => {
    const { sb } = mount();
    await flush();

    const headerText = document.createElement("span");
    document.body.appendChild(headerText);
    sb.toggleEffortPopover(headerText);
    expect(popover("effort")).not.toBeNull();

    rerender(sb);

    expect(popover("effort")).not.toBeNull();
  });

  it("closes a header-anchored slider once that header is torn down", async () => {
    // Default rows carry no effort chip, so there is no fallback anchor to
    // land on once the header's own text is gone.
    const { sb } = mount([["context_pct"]]);
    await flush();

    const headerText = document.createElement("span");
    document.body.appendChild(headerText);
    sb.toggleEffortPopover(headerText);
    // Chat switch: the old pane header, popover anchor and all, is discarded.
    headerText.remove();

    rerender(sb);

    expect(popover("effort")).toBeNull();
  });
});
