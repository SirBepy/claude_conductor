// @vitest-environment jsdom

// Red->green: Ctrl/Cmd+Enter in the lightbox's caption box used to do
// nothing (ComposerCore's onCtrlEnter branch is gated on the option being
// supplied, and the lightbox's own composer-core instance never passed one -
// Enter and Ctrl+Enter both just inserted a newline). Typing a caption while
// viewing an attachment and hitting Ctrl+Enter should send that caption as
// the chat message AND close the preview in one keystroke.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mountComposer, destroyMounted, tauriMock } from "./helpers/composer-mount.mjs";

vi.setConfig({ testTimeout: 30000 });

let openLightbox;
let closeLightbox;
let onSend;

beforeEach(async () => {
  localStorage.clear();
  tauriMock();
  ({ openLightbox, closeLightbox } = await import("../src/shared/chat/lightbox.ts"));
});

afterEach(() => {
  closeLightbox();
  destroyMounted();
  document.body.innerHTML = "";
  delete globalThis.window.__TAURI__;
  localStorage.clear();
});

function captionBox() {
  return document.querySelector(".lightbox-composer");
}

function overlay() {
  return document.querySelector(".lightbox-overlay");
}

function ctrlEnter(el) {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
}

describe("lightbox Ctrl+Enter", () => {
  it("sends the typed caption and closes the preview", async () => {
    onSend = vi.fn(async () => {});
    await mountComposer({ onSend });

    openLightbox({ type: "text", content: "log line", filename: "out.txt" });
    captionBox().value = "look at this";
    ctrlEnter(captionBox());

    expect(overlay()).toBeNull();
    expect(onSend).toHaveBeenCalledTimes(1);
    const blocks = onSend.mock.calls[0][0];
    expect(blocks).toEqual([{ type: "text", text: "look at this" }]);
  });

  it("does nothing destructive when the caption is empty", async () => {
    onSend = vi.fn(async () => {});
    await mountComposer({ onSend });

    openLightbox({ type: "text", content: "log line", filename: "out.txt" });
    ctrlEnter(captionBox());

    expect(overlay()).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });
});
