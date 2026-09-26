// @vitest-environment jsdom

// Red->green regression for the lightbox caption box posting into the WRONG
// chat. `setLightboxComposerBridge` used to have a single call site in
// active-session-composer.ts's mountComposer, so pending-pane.ts - which
// builds its own Composer - never registered, and nothing ever unregistered.
// A draft chat therefore previewed an image against the PREVIOUS session's
// composer object (destroy() doesn't null its textarea, so setDraftText still
// ran saveDraft under that session's id) and the caption surfaced in the chat
// the user had open before.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mountComposer, destroyMounted, tauriMock } from "./helpers/composer-mount.mjs";

// Mounting a real Composer pulls its whole module graph plus the slash/file
// command fetch, which runs well past the 5s default on a cold transform.
vi.setConfig({ testTimeout: 30000 });

const PREV = "sess-roblox";
const DRAFT = "pending-1790381210894-06605995";

let openLightbox;
let closeLightbox;
let loadDraft;
let invoke;

beforeEach(async () => {
  localStorage.clear();
  invoke = tauriMock();
  ({ openLightbox, closeLightbox } = await import("../src/shared/chat/lightbox.ts"));
  ({ loadDraft } = await import("../src/shared/chat/composer-persistence.ts"));
});

afterEach(() => {
  closeLightbox();
  destroyMounted();
  document.body.innerHTML = "";
  delete globalThis.window.__TAURI__;
  localStorage.clear();
});

/** The caption box, or null when no composer was mounted to hand text to. */
function captionBox() {
  return document.querySelector(".lightbox-composer");
}

/** Text preview: type-independent for the caption box (lightbox.ts builds the
 *  same box for image/pdf/text) and the only one that needs no base64 decode. */
function openTextPreview() {
  openLightbox({ type: "text", content: "log line", filename: "out.txt" });
}

describe("lightbox caption box ownership", () => {
  it("writes the caption to the mounted draft chat, not the previous chat", async () => {
    await mountComposer({ projectDir: "C:/prev" }, PREV);
    destroyMounted();
    await mountComposer({ projectDir: "C:/draft" }, DRAFT);

    openTextPreview();
    captionBox().value = "the weirdest thing happened";
    closeLightbox();

    expect(loadDraft(DRAFT)).toBe("the weirdest thing happened");
    expect(loadDraft(PREV)).toBe("");
  });

  it("seeds from the mounted draft chat, not the previous chat", async () => {
    const { textarea: prevTa } = await mountComposer({}, PREV);
    prevTa.value = "older chat's half-written message";
    prevTa.dispatchEvent(new Event("input", { bubbles: true }));
    destroyMounted();
    await mountComposer({}, DRAFT);

    openTextPreview();

    expect(captionBox().value).toBe("");
  });

  it("keeps the caption with the chat it was typed in across a session switch", async () => {
    // Ctrl+Num jumps chats without touching the overlay, so the registered
    // composer can be swapped out from under an open preview.
    await mountComposer({}, PREV);
    openTextPreview();
    captionBox().value = "typed while PREV was mounted";

    destroyMounted();
    await mountComposer({}, DRAFT);
    closeLightbox();

    expect(loadDraft(PREV)).toBe("typed while PREV was mounted");
    expect(loadDraft(DRAFT)).toBe("");
  });

  it("offers no caption box once the last composer is destroyed", async () => {
    await mountComposer({}, PREV);
    destroyMounted();

    openTextPreview();

    expect(captionBox()).toBeNull();
  });

  it("takes the project dir from the mounted composer for its suggest providers", async () => {
    await mountComposer({ projectDir: "C:/prev" }, PREV);
    destroyMounted();
    await mountComposer({ projectDir: "C:/draft" }, DRAFT);
    invoke.mockClear();

    openTextPreview();

    await vi.waitFor(() => {
      const dirs = invoke.mock.calls
        .filter(([cmd]) => cmd === "list_slash_commands")
        .map(([, args]) => args?.projectDir);
      expect(dirs).toContain("C:/draft");
      expect(dirs).not.toContain("C:/prev");
    });
  });
});
