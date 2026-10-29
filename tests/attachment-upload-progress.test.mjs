// @vitest-environment jsdom

// Red->green regression (reported 2026-10-29): picking an image on the phone
// showed nothing until its upload finished, seconds later, so it read as a
// failed pick and got picked again, sending the image twice. The chip must
// appear at once in an uploading state, and a send/submit pressed meanwhile
// must wait for the upload instead of dropping the image.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mountComposer, destroyMounted, tauriMock } from "./helpers/composer-mount.mjs";

vi.setConfig({ testTimeout: 30000 });

const UPLOADED = "/data/chat-attachments/sess-1/u.png";
const png = (name = "photo.png") => new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

let upload;

beforeEach(() => {
  localStorage.clear();
  upload = deferred();
  tauriMock((cmd) => (cmd === "paste_attachment" ? upload.promise : undefined));
});

afterEach(() => {
  destroyMounted();
  document.body.innerHTML = "";
  delete globalThis.window.__TAURI__;
  localStorage.clear();
});

describe("composer attachment upload progress", () => {
  it("shows a popping, uploading chip before the upload finishes", async () => {
    const { composer, root } = await mountComposer();

    const attaching = composer.dropFiles([png()]);

    const chip = root.querySelector(".composer-attachments .attachment");
    expect(chip).toBeTruthy();
    expect(chip.classList.contains("uploading")).toBe(true);
    expect(chip.classList.contains("attachment--pop")).toBe(true);
    expect(chip.querySelector(".attachment-progress")).toBeTruthy();

    upload.resolve(UPLOADED);
    await attaching;

    const settled = root.querySelector(".composer-attachments .attachment");
    expect(settled.classList.contains("uploading")).toBe(false);
    expect(settled.querySelector(".attachment-progress")).toBeNull();
    expect(settled.querySelector("img")).toBeTruthy();
  });

  it("holds a send until the upload lands, then sends the uploaded path", async () => {
    const onSend = vi.fn(async () => {});
    const { composer, root, textarea } = await mountComposer({ onSend });

    void composer.dropFiles([png()]);
    textarea.value = "look at this";
    textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    await new Promise((r) => setTimeout(r, 50));
    expect(onSend).not.toHaveBeenCalled();
    expect(root.querySelector(".composer-send.spinning")).toBeTruthy();

    upload.resolve(UPLOADED);
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const texts = onSend.mock.calls[0][0].map((b) => b.text);
    expect(texts).toContain(`<file:${UPLOADED}::photo.png>`);
    expect(texts.join("\n")).not.toContain("attachment dropped");
  });
});
