// @vitest-environment jsdom

// Regression for: pressing Send while still dictating used to read the
// textarea and clear it (via ComposerVoice.reset(), which fires `void
// controller.stop()` without awaiting it) before the sidecar's trailing
// transcript for the last word(s) spoken arrived - those words then landed
// in the *next* draft instead of the sent message. finishForSend() exists so
// Composer.send() can await the real flush before reading the textarea.

import { describe, it, expect, vi } from "vitest";

let ctorCb;

class FakeController {
  constructor(cb) {
    ctorCb = cb;
    this.recording = false;
  }

  get isRecording() {
    return this.recording;
  }

  async start() {
    this.recording = true;
  }

  // Mirrors the real VoiceController.stop(): the sidecar's final transcript
  // for the tail of the recording arrives *during* the post-stop wait, before
  // stop()'s own promise resolves - never before it, never after.
  async stop() {
    this.recording = false;
    await new Promise((r) => setTimeout(r, 10));
    ctorCb.onFinal("world");
  }

  async destroy() {}
}

vi.mock("../src/shared/chat/voice/controller.ts", () => ({
  warmVoiceEngine: vi.fn(async () => {}),
  VoiceController: FakeController,
}));

const { ComposerVoice } = await import("../src/shared/chat/voice/composer-voice.ts");

describe("ComposerVoice.finishForSend", () => {
  it("awaits the sidecar's trailing final before resolving, so it lands in the textarea", async () => {
    const ta = document.createElement("textarea");
    ta.value = "hello ";
    document.body.appendChild(ta);

    const cv = new ComposerVoice({ onAfterEdit() {}, onHighlightOnly() {} });
    cv.mount(document.createElement("button"), ta);

    await cv.toggle(6); // starts the (fake) recording at commitPos 6
    cv["onPartial"]("som"); // mid-word partial still showing when Send is clicked

    await cv.finishForSend();

    expect(ta.value).toBe("hello world");
  });

  it("is a no-op when not recording", async () => {
    const ta = document.createElement("textarea");
    ta.value = "already typed";
    document.body.appendChild(ta);

    const cv = new ComposerVoice({ onAfterEdit() {}, onHighlightOnly() {} });
    cv.mount(document.createElement("button"), ta);

    await expect(cv.finishForSend()).resolves.toBeUndefined();
    expect(ta.value).toBe("already typed");
  });
});
