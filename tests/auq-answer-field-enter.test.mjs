// @vitest-environment jsdom
//
// The question card's answer box is the shared composer field, so it follows
// the chat's Enter rule: on desktop Enter fires the footer's primary button
// and Shift+Enter is a newline; on a
// phone Enter is always a newline. Ctrl+Enter must still fire the primary
// only once - the card's own document handler owns that shortcut.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn().mockResolvedValue([]) }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
vi.mock("tauri-plugin-clipboard-api", () => ({
  hasFiles: vi.fn().mockResolvedValue(false),
  readFiles: vi.fn().mockResolvedValue([]),
}));

const { renderQuestionUI } = await import("../src/views/sessions/permission-modal/question-ui.ts");

function setViewport(mobile) {
  window.matchMedia = (q) => ({
    matches: mobile && q.includes("max-width: 768px"),
    media: q,
    addEventListener() {},
    removeEventListener() {},
  });
}

function open() {
  const opts = {
    questions: [{ question: "Pick one?", header: "Choice", options: [{ label: "A" }, { label: "B" }] }],
    titleText: "Question",
    titleIcon: "ph-question",
    cancelLabel: "Skip",
    submitLabel: "Submit",
    submitIcon: "ph-check",
    onCancel: vi.fn(),
    onSubmit: vi.fn(),
  };
  renderQuestionUI(opts);
  const ta = document.querySelector(".prompt-card__answer-bar .prompt-q__other-input");
  ta.value = "my own answer";
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  return { opts, ta };
}

function key(ta, init) {
  const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
  ta.dispatchEvent(ev);
  return ev;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("AUQ answer field Enter", () => {
  // One way forward per step (Joe, 2026-10-26): the footer's Next/Submit,
  // so the desktop answer box has no paper-plane of its own beside it.
  it("drops the answer box's own send arrow on desktop", () => {
    setViewport(false);
    open();
    expect(document.querySelector(".prompt-card__answer-bar textarea")).toBeTruthy();
    expect(document.querySelector(".prompt-card__answer-bar .composer-field-send")).toBeNull();
    expect(document.querySelector('.prompt-card__footer [data-act="primary"]')).toBeTruthy();
  });

  it("desktop: Shift+Enter is a newline, Enter submits", () => {
    setViewport(false);
    const { opts, ta } = open();
    expect(key(ta, { shiftKey: true }).defaultPrevented).toBe(false);
    expect(opts.onSubmit).not.toHaveBeenCalled();
    key(ta, {});
    expect(opts.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("desktop: Ctrl+Enter submits exactly once", () => {
    setViewport(false);
    const { opts, ta } = open();
    key(ta, { ctrlKey: true });
    expect(opts.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("phone: Enter is a newline and never submits", () => {
    setViewport(true);
    const { opts, ta } = open();
    expect(key(ta, {}).defaultPrevented).toBe(false);
    expect(opts.onSubmit).not.toHaveBeenCalled();
  });
});
