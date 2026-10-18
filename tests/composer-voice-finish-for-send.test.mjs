// @vitest-environment jsdom

// Regression for: pressing Send while still dictating used to read the
// textarea and clear it (via ComposerVoice.reset(), which fires `void
// controller.stop()` without awaiting it) before the sidecar's trailing
// transcript for the last word(s) spoken arrived - those words then landed
// in the *next* draft instead of the sent message. finishForSend() exists so
// Composer.send() can await the real flush before reading the textarea.

import { describe, it, expect, vi, beforeEach } from "vitest";

let ctorCb;
// Identity passthrough by default so the finishForSend tests below (which
// care about the flush, not the cleanup pass) see the raw transcript
// unchanged; cleanup-specific tests below override per-call.
const cleanMock = vi.fn(async (raw) => raw);

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
  cleanDictatedText: (...args) => cleanMock(...args),
  VoiceController: FakeController,
}));

beforeEach(() => {
  cleanMock.mockReset();
  cleanMock.mockImplementation(async (raw) => raw);
});

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

// Dictation cleanup pass (silent, on-finalize - Joe's chosen option, 2026-10-18):
// stopping a dictation runs a cheap LLM pass over just the text that
// dictation produced, replacing it in place before Send (or anyone else)
// reads the textarea.
describe("ComposerVoice dictation cleanup pass", () => {
  it("replaces the dictated span with the cleaned text on stop", async () => {
    const ta = document.createElement("textarea");
    ta.value = "hello ";
    document.body.appendChild(ta);

    cleanMock.mockImplementation(async (raw) => raw.toUpperCase());

    const cv = new ComposerVoice({ onAfterEdit() {}, onHighlightOnly() {} });
    cv.mount(document.createElement("button"), ta);

    await cv.toggle(6);
    await cv.finishForSend(); // FakeController.stop() emits onFinal("world")

    expect(cleanMock).toHaveBeenCalledWith("world");
    expect(ta.value).toBe("hello WORLD");
    expect(cv.commitPos).toBe(ta.value.length);
  });

  it("keeps the raw transcript if the cleanup call fails", async () => {
    const ta = document.createElement("textarea");
    ta.value = "hello ";
    document.body.appendChild(ta);

    cleanMock.mockImplementation(async () => {
      throw new Error("no account configured");
    });

    const cv = new ComposerVoice({ onAfterEdit() {}, onHighlightOnly() {} });
    cv.mount(document.createElement("button"), ta);

    await cv.toggle(6);
    await expect(cv.finishForSend()).resolves.toBeUndefined();

    expect(ta.value).toBe("hello world");
  });

  it("does not overwrite a manual edit made to the dictated span while cleanup was in flight", async () => {
    const ta = document.createElement("textarea");
    ta.value = "hello ";
    document.body.appendChild(ta);

    let resolveCleanup;
    cleanMock.mockImplementation(
      () => new Promise((resolve) => { resolveCleanup = resolve; }),
    );

    const cv = new ComposerVoice({ onAfterEdit() {}, onHighlightOnly() {} });
    cv.mount(document.createElement("button"), ta);

    await cv.toggle(6);
    const stopping = cv.finishForSend();

    // Let FakeController.stop()'s 10ms flush land (onFinal("world") fires,
    // so cleanupDictation captures "world" as the raw span) before the user
    // edits that exact span out from under the in-flight cleanup call.
    await new Promise((r) => setTimeout(r, 20));
    ta.value = "hello mundo";
    resolveCleanup("WORLD");

    await stopping;
    expect(ta.value).toBe("hello mundo");
  });
});
