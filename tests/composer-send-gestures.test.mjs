// @vitest-environment jsdom

// Send is one plain button: schedule (and voice, when enabled) hang off a
// right-click, a long-press or a swipe-up on it instead of a chevron beside it,
// and the phone's paperclip replaces the old "Attach image" menu row.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mountComposer, destroyMounted, tauriMock } from "./helpers/composer-mount.mjs";

const { wireSendGestures } = await import("../src/shared/chat/composer-send-gestures.ts");

vi.setConfig({ testTimeout: 30000 });

function pointer(type, init = {}) {
  // jsdom has no PointerEvent; a MouseEvent carries the same button/clientY fields.
  return new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
}

describe("wireSendGestures", () => {
  let btn;
  let wrap;
  let cb;

  beforeEach(() => {
    vi.useFakeTimers();
    wrap = document.createElement("div");
    btn = document.createElement("button");
    wrap.appendChild(btn);
    document.body.appendChild(wrap);
    cb = {
      onMenu: vi.fn(),
      onSwipeUp: vi.fn(),
      swipeUpEnabled: () => false,
      isDisabled: () => false,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("opens the menu after a 450ms hold, shows the ring meanwhile, and swallows the click that follows", () => {
    const clicked = vi.fn();
    wireSendGestures(btn, wrap, cb);
    btn.addEventListener("click", clicked);

    btn.dispatchEvent(pointer("pointerdown"));
    expect(wrap.classList.contains("holding")).toBe(true);
    vi.advanceTimersByTime(449);
    expect(cb.onMenu).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb.onMenu).toHaveBeenCalledTimes(1);
    expect(wrap.classList.contains("holding")).toBe(false);

    btn.dispatchEvent(pointer("pointerup"));
    btn.click();
    expect(clicked).not.toHaveBeenCalled();

    // Only the one click after a gesture is swallowed.
    btn.click();
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("lets a short press through as a normal click", () => {
    const clicked = vi.fn();
    wireSendGestures(btn, wrap, cb);
    btn.addEventListener("click", clicked);

    btn.dispatchEvent(pointer("pointerdown"));
    vi.advanceTimersByTime(100);
    btn.dispatchEvent(pointer("pointerup"));
    btn.click();
    vi.advanceTimersByTime(1000);

    expect(clicked).toHaveBeenCalledTimes(1);
    expect(cb.onMenu).not.toHaveBeenCalled();
    expect(wrap.classList.contains("holding")).toBe(false);
  });

  it("opens the menu on right-click without letting the browser menu through", () => {
    wireSendGestures(btn, wrap, cb);
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    btn.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(cb.onMenu).toHaveBeenCalledTimes(1);
  });

  it("opens one menu when a touch long-press raises contextmenu on top of the hold timer", () => {
    wireSendGestures(btn, wrap, cb);
    btn.dispatchEvent(pointer("pointerdown"));
    vi.advanceTimersByTime(450);
    btn.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(cb.onMenu).toHaveBeenCalledTimes(1);
  });

  it("does nothing while disabled", () => {
    cb.isDisabled = () => true;
    wireSendGestures(btn, wrap, cb);
    btn.dispatchEvent(pointer("pointerdown"));
    vi.advanceTimersByTime(1000);
    btn.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(cb.onMenu).not.toHaveBeenCalled();
  });

  it("swipe-up past 40px fires only when voice is enabled, and swallows the click", () => {
    const clicked = vi.fn();
    cb.swipeUpEnabled = () => true;
    wireSendGestures(btn, wrap, cb);
    btn.addEventListener("click", clicked);

    btn.dispatchEvent(pointer("pointerdown", { clientY: 200 }));
    btn.dispatchEvent(pointer("pointermove", { clientY: 170 }));
    expect(cb.onSwipeUp).not.toHaveBeenCalled();
    btn.dispatchEvent(pointer("pointermove", { clientY: 150 }));
    expect(cb.onSwipeUp).toHaveBeenCalledTimes(1);
    btn.dispatchEvent(pointer("pointerup"));
    btn.click();
    expect(clicked).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(cb.onMenu).not.toHaveBeenCalled();
  });

  it("ignores a swipe-up while voice is off", () => {
    wireSendGestures(btn, wrap, cb);
    btn.dispatchEvent(pointer("pointerdown", { clientY: 200 }));
    btn.dispatchEvent(pointer("pointermove", { clientY: 100 }));
    expect(cb.onSwipeUp).not.toHaveBeenCalled();
  });
});

describe("Composer's Send", () => {
  beforeEach(() => {
    localStorage.clear();
    tauriMock();
  });

  afterEach(() => {
    destroyMounted();
    document.body.innerHTML = "";
    delete globalThis.window.__TAURI__;
    localStorage.clear();
    vi.restoreAllMocks();
  });

  const type = (textarea, text) => {
    textarea.value = text;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  };

  it("has no schedule chevron beside it", async () => {
    const { root } = await mountComposer({ onSchedule: vi.fn() });
    expect(root.querySelector(".composer-send-chevron")).toBeNull();
    expect(root.querySelector(".composer-send-split")).toBeNull();
  });

  it("takes the ready fill only while there is a draft", async () => {
    const { root, textarea } = await mountComposer();
    const send = root.querySelector(".composer-send");
    expect(send.classList.contains("composer-send--ready")).toBe(false);
    // The empty Send stays clickable: a held set can still flush through it.
    expect(send.disabled).toBe(false);

    type(textarea, "hello");
    expect(send.classList.contains("composer-send--ready")).toBe(true);

    type(textarea, "");
    expect(send.classList.contains("composer-send--ready")).toBe(false);
  });

  it("drops the ready fill again once the draft is sent", async () => {
    const { root, textarea } = await mountComposer();
    const send = root.querySelector(".composer-send");
    type(textarea, "hello");
    send.click();
    await vi.waitFor(() => expect(textarea.value).toBe(""));
    expect(send.classList.contains("composer-send--ready")).toBe(false);
  });

  it("right-click with a draft offers Schedule message", async () => {
    const { root, textarea } = await mountComposer({ onSchedule: vi.fn() });
    type(textarea, "later");
    root.querySelector(".composer-send").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const rows = [...document.querySelectorAll(".composer-menu-popover [data-idx]")].map((b) => b.textContent.trim());
    expect(rows).toEqual(["Schedule message"]);
  });

  it("right-click on an empty draft opens no menu and says there is nothing to schedule", async () => {
    const { root } = await mountComposer({ onSchedule: vi.fn() });
    root.querySelector(".composer-send").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(document.querySelector(".composer-menu-popover")).toBeNull();
    const notice = root.querySelector(".composer-notice");
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toBe("Nothing to schedule yet.");
  });

  it("both paperclips open the native file picker", async () => {
    const { root } = await mountComposer();
    const input = root.querySelector(".composer-file-input");
    const picked = vi.fn();
    input.addEventListener("click", picked);
    root.querySelector(".composer-attach-in").click();
    root.querySelector(".composer-attach").click();
    expect(picked).toHaveBeenCalledTimes(2);
  });

  it("names the schedule gesture in Send's tooltip only when scheduling exists", async () => {
    const withSchedule = await mountComposer({ onSchedule: vi.fn() });
    expect(withSchedule.root.querySelector(".composer-send").title).toContain("Right-click or hold");
    destroyMounted();
    document.body.innerHTML = "";
    const without = await mountComposer();
    expect(without.root.querySelector(".composer-send").title).toBe("Send");
  });
});
