// @vitest-environment jsdom
//
// The Ask panel's box is the shared composer field (composer-field.ts): on a
// phone Enter must add a newline instead of sending (it used to be a one-line
// <input> that sent mid-sentence), on desktop Enter sends and Shift+Enter is a
// newline, and answers render as the chat's own markdown bubbles.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));

const { mountAskPanel } = await import("../src/views/sessions/ask-panel.ts");

function setViewport(mobile) {
  window.matchMedia = (q) => ({
    matches: mobile && q.includes("max-width: 768px"),
    media: q,
    addEventListener() {},
    removeEventListener() {},
  });
}

function mount() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const panel = mountAskPanel(root, { onDraft: () => {} });
  panel.setSessionScope("s1");
  return { root, panel };
}

function type(ta, text) {
  ta.value = text;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

function enter(ta, init = {}) {
  const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
  ta.dispatchEvent(ev);
  return ev;
}

const sends = () => invokeMock.mock.calls.filter(([cmd]) => cmd === "ask_send");

describe("Ask panel field", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd) => (cmd === "ask_list_threads" ? [] : new Promise(() => {})));
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("is a textarea with the shared paper-plane send, not a one-line input", () => {
    setViewport(false);
    const { root } = mount();
    expect(root.querySelector("input[data-ask-input]")).toBeNull();
    const ta = root.querySelector("textarea.composer-textarea[data-ask-input]");
    expect(ta).toBeTruthy();
    expect(root.querySelector(".composer-field .composer-field-send .ph-paper-plane-right")).toBeTruthy();
  });

  it("on a phone, Enter is a newline and never sends", () => {
    setViewport(true);
    const { root } = mount();
    const ta = root.querySelector("[data-ask-input]");
    type(ta, "I was trying to ask");
    const ev = enter(ta);
    expect(ev.defaultPrevented).toBe(false);
    expect(sends()).toHaveLength(0);
  });

  it("on desktop, Shift+Enter is a newline and Enter sends", () => {
    setViewport(false);
    const { root } = mount();
    const ta = root.querySelector("[data-ask-input]");
    type(ta, "what does this do?");
    expect(enter(ta, { shiftKey: true }).defaultPrevented).toBe(false);
    expect(sends()).toHaveLength(0);
    expect(enter(ta).defaultPrevented).toBe(true);
    expect(sends()).toHaveLength(1);
    expect(sends()[0][1].question).toBe("what does this do?");
    expect(ta.value).toBe("");
  });

  it("renders answers as chat markdown bubbles", async () => {
    setViewport(false);
    invokeMock.mockImplementation(async (cmd) =>
      cmd === "ask_list_threads"
        ? [{ id: "t1", title: "T", messages: [
            { role: "user", text: "q" },
            { role: "assistant", text: "- **bold** item" },
          ] }]
        : null,
    );
    const { root } = mount();
    await vi.waitFor(() => expect(root.querySelector(".msg.assistant")).toBeTruthy());
    expect(root.querySelector(".msg.user")).toBeTruthy();
    expect(root.querySelector(".msg.assistant li strong")?.textContent).toBe("bold");
    expect(root.querySelector(".msg.assistant").textContent).not.toContain("**");
  });
});
