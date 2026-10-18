// @vitest-environment jsdom

// Regression for: the lightbox's full-screen overlay (z-index 9999) covers
// the composer's own mic button, so opening an attachment preview while
// dictating made recording LOOK stopped even though audio capture never
// paused - Joe hit this directly (2026-10-18) opening an attached image mid-
// dictation. The lightbox now shows its own ".lightbox-voice-badge" while
// ComposerVoice.state is "recording"/"connecting", via the bridge's
// isVoiceRecording()/onVoiceStateChange() added for exactly this.

import { describe, it, expect, vi, afterEach } from "vitest";
import { mountComposer, destroyMounted, tauriMock } from "./helpers/composer-mount.mjs";

vi.setConfig({ testTimeout: 30000 });

let openLightbox;
let closeLightbox;

afterEach(() => {
  closeLightbox();
  destroyMounted();
  document.body.innerHTML = "";
  delete globalThis.window.__TAURI__;
});

function badge() {
  return document.querySelector(".lightbox-voice-badge");
}

describe("lightbox voice-recording badge", () => {
  it("shows the badge when opened mid-dictation, hides it once dictation stops", async () => {
    tauriMock();
    ({ openLightbox, closeLightbox } = await import("../src/shared/chat/lightbox.ts"));
    const { composer } = await mountComposer();

    composer["cv"]["onStateChange"]("recording");
    openLightbox({ type: "text", content: "log line", filename: "out.txt" });

    expect(badge()).not.toBeNull();

    composer["cv"]["onStateChange"]("idle");

    expect(badge()).toBeNull();
  });

  it("shows no badge when opened while idle", async () => {
    tauriMock();
    ({ openLightbox, closeLightbox } = await import("../src/shared/chat/lightbox.ts"));
    await mountComposer();

    openLightbox({ type: "text", content: "log line", filename: "out.txt" });

    expect(badge()).toBeNull();
  });

  it("stops listening once the lightbox is closed", async () => {
    tauriMock();
    ({ openLightbox, closeLightbox } = await import("../src/shared/chat/lightbox.ts"));
    const { composer } = await mountComposer();

    composer["cv"]["onStateChange"]("recording");
    openLightbox({ type: "text", content: "log line", filename: "out.txt" });
    closeLightbox();

    // A state flip after close must not throw (no stale overlay reference)
    // and must not resurrect a badge with no overlay to hold it.
    expect(() => composer["cv"]["onStateChange"]("idle")).not.toThrow();
    expect(badge()).toBeNull();
  });
});
