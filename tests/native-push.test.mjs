import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The Android shell hands the phone SPA a relay handle; the SPA must pass it to
// the daemon (register_fcm_handle) and route notification taps to the chat.

const { installNativePush } = await import("../src/shared/native-push.ts");

function setWindow(win) {
  globalThis.window = win;
}

describe("installNativePush", () => {
  let register;
  let openChat;

  beforeEach(() => {
    register = vi.fn().mockResolvedValue({ ok: true });
    openChat = vi.fn();
  });

  afterEach(() => {
    delete globalThis.window;
    delete globalThis.document;
  });

  it("registers the handle the bridge returns", () => {
    setWindow({ ConductorPush: { getHandle: () => JSON.stringify({ handle: "h1", secret: "s1" }) } });
    installNativePush({ register, openChat });
    expect(register).toHaveBeenCalledWith("h1", "s1");
  });

  it("skips when the bridge returns an empty string or junk", () => {
    setWindow({ ConductorPush: { getHandle: () => "" } });
    installNativePush({ register, openChat });
    setWindow({ ConductorPush: { getHandle: () => "not json" } });
    installNativePush({ register, openChat });
    setWindow({ ConductorPush: { getHandle: () => JSON.stringify({ handle: "h1" }) } });
    installNativePush({ register, openChat });
    expect(register).not.toHaveBeenCalled();
  });

  it("skips on desktop (Tauri) and when there is no bridge", () => {
    setWindow({ __TAURI__: {}, ConductorPush: { getHandle: () => JSON.stringify({ handle: "h", secret: "s" }) } });
    installNativePush({ register, openChat });
    setWindow({});
    installNativePush({ register, openChat });
    expect(register).not.toHaveBeenCalled();
  });

  it("registers again when the shell reports a handle after page load", () => {
    let current = "";
    const win = { ConductorPush: { getHandle: () => current } };
    setWindow(win);
    installNativePush({ register, openChat });
    expect(register).not.toHaveBeenCalled();
    current = JSON.stringify({ handle: "late", secret: "s" });
    win.__ccPushHandleReady();
    expect(register).toHaveBeenCalledWith("late", "s");
  });

  it("retries a failed registration when the app comes back to the foreground, until it succeeds", async () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: "hidden" });
    globalThis.document = doc;
    setWindow({ ConductorPush: { getHandle: () => JSON.stringify({ handle: "h1", secret: "s1" }) } });
    register.mockRejectedValueOnce(new Error("daemon unreachable"));
    installNativePush({ register, openChat });
    await Promise.resolve();
    await Promise.resolve();

    doc.dispatchEvent(new Event("visibilitychange"));
    expect(register).toHaveBeenCalledTimes(1);
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(register).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    await Promise.resolve();
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(register).toHaveBeenCalledTimes(2);
  });

  it("__ccOpenChat opens the tapped chat", () => {
    const win = { ConductorPush: { getHandle: () => "" } };
    setWindow(win);
    installNativePush({ register, openChat });
    win.__ccOpenChat("session-42");
    expect(openChat).toHaveBeenCalledWith("session-42");
  });
});
