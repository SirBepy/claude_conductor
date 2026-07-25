// @vitest-environment jsdom
//
// The context chip's percentage comes exclusively from the daemon's
// `context_status` IPC (the single source of truth - ai_todo 31 removed the
// frontend's duplicate modelContextWindow calc entirely). This drives the
// real SessionStatusbar so a revert to an independent frontend heuristic is
// caught:
//   - daemon value renders as the chip pct + color tier,
//   - heuristic confidence is noted via the title, not a ~ prefix,
//   - a null IPC result renders a loading skeleton, never a self-computed
//     estimate (chip never fabricates a number the daemon didn't provide).

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mockable invoke. Each test sets ipcMock.impl to control context_status.
const ipcMock = { impl: async () => null };
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn((cmd, args) => ipcMock.impl(cmd, args)),
}));

const { SessionStatusbar } = await import("../src/views/sessions/session-statusbar.ts");
const { ctxStatusCache, metaCache } = await import("../src/views/sessions/session-statusbar-helpers.ts");

function makeCtx(overrides = {}) {
  return {
    model: "claude-opus-4-8",
    window: 1_000_000n,
    occupancy: 600_000n,
    remaining: 400_000n,
    pct_used: 60,
    pct_left: 40,
    confidence: "proven",
    ...overrides,
  };
}

// Lets the awaited invoke + the render it triggers settle.
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function mount(opts) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const sb = new SessionStatusbar(el, null, [["context_pct"]], { sessionId: "sess-1", hideZero: true, ...opts });
  return { el, sb };
}

function chip(el) {
  return el.querySelector(".sb-context");
}

beforeEach(() => {
  ctxStatusCache.clear();
  metaCache.clear();
  ipcMock.impl = async () => null;
  document.body.innerHTML = "";
});

describe("context chip - daemon source of truth", () => {
  it("renders the daemon pct_used and the warn tier", async () => {
    ipcMock.impl = async () => makeCtx({ pct_used: 60 });
    const { el } = mount();
    await flush();
    const c = chip(el);
    expect(c).not.toBeNull();
    expect(c.textContent).toContain("60%");
    expect(c.className).toContain("warn");
    expect(c.className).not.toContain("danger");
  });

  it("applies the danger tier at >=80", async () => {
    ipcMock.impl = async () => makeCtx({ pct_used: 92, occupancy: 920_000n });
    const { el } = mount();
    await flush();
    const c = chip(el);
    expect(c.textContent).toContain("92%");
    expect(c.className).toContain("danger");
  });

  it("marks heuristic confidence via the title, not a ~ prefix", async () => {
    ipcMock.impl = async () => makeCtx({ pct_used: 45, confidence: "heuristic" });
    const { el } = mount();
    await flush();
    const c = chip(el);
    expect(c.textContent).toContain("45%");
    expect(c.textContent).not.toContain("~");
    expect(c.getAttribute("title")).toContain("(estimated)");
    expect(c.className).not.toContain("warn");
  });

  it("no ~ when confidence is proven", async () => {
    ipcMock.impl = async () => makeCtx({ pct_used: 45, confidence: "proven" });
    const { el } = mount();
    await flush();
    const c = chip(el);
    expect(c.textContent).not.toContain("~");
    expect(c.textContent).toContain("45%");
    expect(c.getAttribute("title")).not.toContain("(estimated)");
  });

  it("renders a loading skeleton (never a self-computed estimate) when context_status returns null", async () => {
    ipcMock.impl = async () => null;
    const { el, sb } = mount();
    await flush();
    // Usage has arrived but the daemon hasn't produced a context_status yet
    // (or ever will, for this test) - ai_todo 31 removed the frontend's
    // independent modelContextWindow calc, so this must stay a skeleton, not
    // a fabricated percentage.
    sb.updateMeta({ model: "claude-opus-4-8", inputTokens: 300_000, hasThinking: false, totalCostUsd: 0, hasUsage: true });
    await flush();
    const c = chip(el);
    expect(c).not.toBeNull();
    expect(c.className).toContain("sb-skeleton");
    expect(c.textContent).not.toContain("%");
  });

  it("prefers the daemon value when both a context_status and usage-bearing meta are available", async () => {
    // Daemon says 70%; meta.updateMeta arriving too must not perturb the
    // daemon-sourced render (there is no frontend calc left to "prefer over").
    ipcMock.impl = async () => makeCtx({ pct_used: 70, occupancy: 700_000n });
    const { el, sb } = mount();
    sb.updateMeta({ model: "claude-opus-4-8", inputTokens: 300_000, hasThinking: false, totalCostUsd: 0, hasUsage: true });
    await flush();
    const c = chip(el);
    expect(c.textContent).toContain("70%");
    expect(c.textContent).not.toContain("30%");
  });
});
