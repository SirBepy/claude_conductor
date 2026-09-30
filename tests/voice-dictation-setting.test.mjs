// @vitest-environment jsdom

// Voice dictation is off unless enabled in Settings: while off, opening a chat
// must not pre-warm the STT sidecar (it holds a ~1.4 GB Whisper model), and a
// push-to-talk binding must not start recording.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { warmMock } = vi.hoisted(() => ({ warmMock: vi.fn(async () => {}) }));
vi.mock("../src/shared/chat/voice/controller.ts", () => ({
  warmVoiceEngine: warmMock,
  VoiceController: class {},
}));

const { setSettings } = await import("../src/shared/state.ts");
const { ComposerVoice, voiceDictationEnabled } = await import("../src/shared/chat/voice/composer-voice.ts");
const { ComposerPtt } = await import("../src/shared/chat/voice/composer-ptt.ts");
const { setPttBinding } = await import("../src/shared/chat/voice/push-to-talk.ts");

beforeEach(() => {
  warmMock.mockClear();
  localStorage.clear();
});

describe("voice dictation setting", () => {
  it("is off when the setting is absent", () => {
    setSettings({});
    expect(voiceDictationEnabled()).toBe(false);
  });

  it("does not warm the sidecar while off, and does once turned on", () => {
    setSettings({});
    new ComposerVoice({ onAfterEdit() {}, onHighlightOnly() {} }).warm();
    expect(warmMock).not.toHaveBeenCalled();

    setSettings({ voiceDictationEnabled: true });
    new ComposerVoice({ onAfterEdit() {}, onHighlightOnly() {} }).warm();
    expect(warmMock).toHaveBeenCalledTimes(1);
  });

  it("ignores the push-to-talk key while off", () => {
    setPttBinding({ kind: "key", code: "F13", label: "F13" });
    const start = vi.fn();
    const ptt = new ComposerPtt({ start, stop() {}, currentInsertPos: () => 0, isMobile: () => false, isDisabled: () => false });
    ptt.mount();

    setSettings({});
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "F13" }));
    expect(start).not.toHaveBeenCalled();

    setSettings({ voiceDictationEnabled: true });
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "F13" }));
    expect(start).toHaveBeenCalledTimes(1);
    ptt.destroy();
  });
});
