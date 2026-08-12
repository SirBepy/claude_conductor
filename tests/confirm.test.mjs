// @vitest-environment jsdom
// In-app askConfirm (shared/confirm.ts): the awaitable replacement for the
// broken `if (!confirm(...))` pattern (Tauri patches window.confirm to a
// Promise-returning dialog command - see the 2026-07-08 unconfirmed-account-
// removal incident). These tests pin the resolution semantics: only the
// confirm button resolves true; cancel, Escape, and backdrop click resolve
// false; the overlay always cleans itself up.

import { describe, it, expect, afterEach } from "vitest";
import { askConfirm } from "../src/shared/confirm.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

function overlay() {
  return document.querySelector(".app-confirm-overlay");
}

describe("askConfirm", () => {
  it("renders the message and resolves true on confirm click", async () => {
    const p = askConfirm("Remove personal?", { confirmLabel: "Remove" });
    expect(overlay()).not.toBeNull();
    // 756944a8 split text at "?" into title/desc; no desc here so it's all title.
    expect(document.querySelector(".app-confirm-title").textContent).toBe("Remove personal?");
    const ok = document.querySelector(".app-confirm-ok");
    expect(ok.textContent).toBe("Remove");
    ok.click();
    await expect(p).resolves.toBe(true);
    expect(overlay()).toBeNull();
  });

  it("resolves false on cancel click", async () => {
    const p = askConfirm("Discard this account setup?", { cancelLabel: "Keep going" });
    const cancel = document.querySelector(".app-confirm-cancel");
    expect(cancel.textContent).toBe("Keep going");
    cancel.click();
    await expect(p).resolves.toBe(false);
    expect(overlay()).toBeNull();
  });

  it("resolves false on Escape", async () => {
    const p = askConfirm("sure?");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect(p).resolves.toBe(false);
    expect(overlay()).toBeNull();
  });

  it("resolves false on backdrop click but NOT on dialog-body click", async () => {
    const p = askConfirm("sure?");
    // Clicking inside the dialog body must not dismiss.
    document.querySelector(".app-confirm").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(overlay()).not.toBeNull();
    // Clicking the backdrop dismisses as false.
    overlay().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await expect(p).resolves.toBe(false);
    expect(overlay()).toBeNull();
  });

  it("styles the confirm button as danger by default, primary when danger:false", () => {
    void askConfirm("a");
    expect(document.querySelector(".app-confirm-ok").classList.contains("btn-danger")).toBe(true);
    document.querySelector(".app-confirm-cancel").click();

    void askConfirm("b", { danger: false });
    const ok = document.querySelectorAll(".app-confirm-ok");
    expect(ok[ok.length - 1].classList.contains("btn-primary")).toBe(true);
    expect(ok[ok.length - 1].classList.contains("btn-danger")).toBe(false);
    document.querySelector(".app-confirm-cancel").click();
  });

  it("stops Escape from reaching underlying handlers (capture phase)", async () => {
    let leaked = false;
    const listener = () => { leaked = true; };
    document.addEventListener("keydown", listener); // bubble phase, like the wizard's
    const p = askConfirm("sure?");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await expect(p).resolves.toBe(false);
    expect(leaked).toBe(false);
    document.removeEventListener("keydown", listener);
  });
});
