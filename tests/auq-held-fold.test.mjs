// Regression: an AUQ answer submitted while messages are HELD (staged during
// the asking turn) must fold cleanly into the question card - no held prose
// leaking into the card's answer text, and the held prose must still reach
// the transcript/model as ordinary content instead of being swallowed.
//
// This wires the real production path: HeldMessages.flushHeldWithDraft's
// bundle (bundleHeld) is fed straight into ChatRenderer.handleEvent as the
// user_message the daemon would echo back, exactly like the app does via
// permission-modal/index.ts onSubmit -> state.heldMessages.flushHeldWithDraft.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { toolUseEvent } from "./helpers/chat-events.mjs";

const invokeMock = vi.fn();
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

if (!globalThis.window) globalThis.window = {};

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { bundleHeld } = await import("../src/shared/chat/held-messages.ts");
const { AUQ_ANSWER_SENTINEL } = await import("../src/shared/chat/chat-transforms.ts");

beforeEach(() => {
  invokeMock.mockReset();
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.IntersectionObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.window.__TAURI__ = undefined;
});

function makeRenderer() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return { r: new ChatRenderer(container), container };
}

describe("AUQ answer fold vs held messages (bug: card stuck / held prose swallowed)", () => {
  it("keeps the folded card text limited to the Q/A pair, and still surfaces the held prose as normal content", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(toolUseEvent("AskUserQuestion", { questions: [{ question: "Pick one?", header: "Choice" }] }, "q1"));

    // Reproduce exactly what flushHeldWithDraft sends: held prose staged while
    // the question was pending, bundled with the answer block.
    const heldItem = [{ type: "text", text: "Also please check the CI logs while you're at it." }];
    const answerBlock = [{ type: "text", text: `${AUQ_ANSWER_SENTINEL}User answered the question(s):\nQ: Pick one?\nA: Option A` }];
    const bundle = bundleHeld([heldItem], answerBlock);

    // The daemon echoes the sent bundle back as a user_message event.
    r.handleEvent({ type: "user_message", content: bundle, timestamp: 0 });

    const qa = container.querySelector(".tool-qa-a");
    expect(qa.textContent).toContain("Option A");
    // (b) the card's answer must NOT be polluted with the held prose.
    expect(qa.textContent).not.toContain("CI logs");

    // (c) the held prose must still be visible in the transcript as ordinary
    // user content - it must not vanish just because it rode along with the
    // AUQ answer in the same held-flush bundle.
    expect(container.textContent).toContain("CI logs");
  });
});
