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

  it("removing a chip whose upload hangs releases a send that was waiting on it", async () => {
    const onSend = vi.fn(async () => {});
    const { composer, root, textarea } = await mountComposer({ onSend });

    void composer.dropFiles([png()]);
    textarea.value = "never mind the image";
    textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 50));
    expect(onSend).not.toHaveBeenCalled();

    // The upload never settles; removing its chip must be enough.
    root.querySelector(".composer-attachments .attachment .rm").click();

    await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const texts = onSend.mock.calls[0][0].map((b) => b.text);
    expect(texts.join("\n")).not.toContain("<file:");
  });

  function scheduleViaMenu(root) {
    root.querySelector(".composer-send-chevron").click();
    const row = [...document.querySelectorAll(".composer-menu-popover [data-idx]")].find((b) =>
      b.textContent.includes("Schedule message"),
    );
    row.click();
    document.querySelector(".schedule-picker-popover [data-preset]").click();
  }

  it("does not schedule a draft that was emptied while the schedule waited on an upload", async () => {
    const onSchedule = vi.fn(async () => {});
    const { composer, root, textarea } = await mountComposer({ onSchedule });

    void composer.dropFiles([png()]);
    textarea.value = "remind me";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    scheduleViaMenu(root);
    await new Promise((r) => setTimeout(r, 50));
    expect(onSchedule).not.toHaveBeenCalled();

    // Emptying the draft is what releases the wait: the chip's removal settles it.
    textarea.value = "";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector(".composer-attachments .attachment .rm").click();
    await new Promise((r) => setTimeout(r, 50));

    expect(onSchedule).not.toHaveBeenCalled();
  });

  it("tells the user when a schedule is confirmed while a send is held, instead of dropping it silently", async () => {
    const onSchedule = vi.fn(async () => {});
    const onSend = vi.fn(async () => {});
    const { composer, root, textarea } = await mountComposer({ onSend, onSchedule });

    void composer.dropFiles([png()]);
    textarea.value = "look at this";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 50));
    expect(root.querySelector(".composer-send.spinning")).toBeTruthy();

    scheduleViaMenu(root);
    await new Promise((r) => setTimeout(r, 20));

    const notice = root.querySelector(".composer-notice");
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain("Still sending");
    expect(onSchedule).not.toHaveBeenCalled();
    upload.resolve(UPLOADED);
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  });

  it("falls back to a named file chip, not a blank image tile, when a path attach fails", async () => {
    tauriMock((cmd) => {
      if (cmd === "paste_attachment_from_path") throw new Error("daemon gone");
      return undefined;
    });
    const { composer, root } = await mountComposer();

    await composer.attachFromPath("C:/Users/me/Desktop/shot.png");

    const chip = root.querySelector(".composer-attachments .attachment");
    expect(chip.classList.contains("file-chip")).toBe(true);
    expect(chip.textContent).toContain("shot.png");
  });
});
