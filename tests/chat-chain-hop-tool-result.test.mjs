// @vitest-environment jsdom

// A chain-hopped ToolResult (event-store.ts loadOlder) must fetch its full
// output from its own session, not the open chat - todo 861. A row without
// the tag still falls back to renderer.sessionId.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

let dom;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ type: "tool_result", output: { type: "text", text: "full" } });
  dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
});

const { createHandleToolResultLoadFullClick } = await import(
  "../src/shared/chat/chat-renderer-click-handlers.ts"
);

function buildButton({ originSession } = {}) {
  const wrap = document.createElement("div");
  wrap.innerHTML =
    `<button type="button" class="tool-result-load-full" data-tool-use-id="tu1" data-seq="5"` +
    (originSession ? ` data-origin-session="${originSession}"` : "") +
    `></button><div class="code-card"></div>`;
  document.body.appendChild(wrap);
  return wrap.querySelector(".tool-result-load-full");
}

describe("chain-hopped tool result fetch", () => {
  it("uses data-origin-session when the row came from a hop", async () => {
    const btn = buildButton({ originSession: "predecessor-session" });
    const renderer = { sessionId: "open-session", paginator: { cwdHint: "/cwd" } };
    const handler = createHandleToolResultLoadFullClick(renderer);
    handler({ target: btn });
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledWith(
      "load_event_detail",
      expect.objectContaining({ sessionId: "predecessor-session", toolUseId: "tu1", seq: 5 }),
    );
  });

  it("falls back to renderer.sessionId when no origin session is tagged", async () => {
    const btn = buildButton();
    const renderer = { sessionId: "open-session", paginator: { cwdHint: "/cwd" } };
    const handler = createHandleToolResultLoadFullClick(renderer);
    handler({ target: btn });
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledWith(
      "load_event_detail",
      expect.objectContaining({ sessionId: "open-session", toolUseId: "tu1", seq: 5 }),
    );
  });
});
