// @vitest-environment jsdom

// Dictated text is written into the composer programmatically, and a
// programmatic value write never scrolls a textarea to its caret. Past the
// composer's max height the words being spoken ran on out of sight.

import { describe, it, expect, vi } from "vitest";

vi.mock("../src/shared/chat/voice/controller.ts", () => ({
  warmVoiceEngine: vi.fn(async () => {}),
  VoiceController: class {},
}));

const { ComposerVoice } = await import("../src/shared/chat/voice/composer-voice.ts");

/** jsdom has no layout: fake one where each character is 1px of content in a
 *  100px-tall box, so scrollHeight tracks how much text sits above the caret. */
function fakeTextarea(initial = "") {
  const ta = document.createElement("textarea");
  ta.value = initial;
  let top = 0;
  Object.defineProperty(ta, "clientHeight", { get: () => 100 });
  Object.defineProperty(ta, "scrollHeight", { get: () => Math.max(100, ta.value.length) });
  Object.defineProperty(ta, "scrollTop", {
    get: () => top,
    set: (v) => { top = Math.max(0, Math.min(v, Math.max(100, ta.value.length) - 100)); },
  });
  document.body.appendChild(ta);
  return ta;
}

function mountVoice(ta) {
  const cv = new ComposerVoice({ onAfterEdit() {}, onHighlightOnly() {} });
  cv.mount(document.createElement("button"), ta);
  return cv;
}

describe("dictation keeps the spoken words in view", () => {
  it("scrolls to the bottom as partials grow past the box", () => {
    const ta = fakeTextarea();
    const cv = mountVoice(ta);
    cv.commitPos = 0;

    cv["onPartial"]("x".repeat(250));

    expect(ta.scrollTop).toBe(150);
  });

  it("follows the caret when dictating into the middle of existing text", () => {
    const ta = fakeTextarea("a".repeat(400));
    const cv = mountVoice(ta);
    cv.commitPos = 100;

    cv["onFinal"]("b".repeat(80));

    // Caret now sits 180px down: just enough scroll to show it, not the end.
    expect(ta.scrollTop).toBe(80);
    expect(ta.selectionStart).toBe(180);
    expect(ta.value).toBe("a".repeat(100) + "b".repeat(80) + "a".repeat(300));
  });

  it("leaves the scroll alone while the caret is already visible", () => {
    const ta = fakeTextarea("a".repeat(400));
    const cv = mountVoice(ta);
    ta.scrollTop = 20;
    cv.commitPos = 30;

    cv["onPartial"]("hi");

    expect(ta.scrollTop).toBe(20);
  });
});
