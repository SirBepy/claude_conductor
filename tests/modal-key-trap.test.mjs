// @vitest-environment jsdom
// todo 834: a modal must swallow keystrokes meant for it, not leak them to
// whatever's still focused behind it (the composer) or to global shortcuts.

import { describe, it, expect, afterEach } from "vitest";
import { lockInputToHost, isAnyModalOpen } from "../src/shared/modal-input-lock.ts";
import { register, unregister, setBinding, resetBinding } from "../src/shared/shortcuts.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

function keydown(key, extra = {}) {
  return new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
}

describe("lockInputToHost", () => {
  it("swallows a keydown outside the host, lets one inside through", () => {
    const host = document.createElement("div");
    const insideBtn = document.createElement("button");
    host.appendChild(insideBtn);
    const outsideBtn = document.createElement("button");
    document.body.append(host, outsideBtn);
    const unlock = lockInputToHost(host);

    let leaked = false;
    const onKeydown = () => { leaked = true; };
    document.addEventListener("keydown", onKeydown);

    const outEvt = keydown("a");
    outsideBtn.dispatchEvent(outEvt);
    expect(outEvt.defaultPrevented).toBe(true);
    expect(leaked).toBe(false);

    const inEvt = keydown("a");
    insideBtn.dispatchEvent(inEvt);
    expect(inEvt.defaultPrevented).toBe(false);
    expect(leaked).toBe(true);

    document.removeEventListener("keydown", onKeydown);
    unlock();
  });

  it("lets Escape pass through so the modal's own handler can close it", () => {
    const host = document.createElement("div");
    const outsideBtn = document.createElement("button");
    document.body.append(host, outsideBtn);
    const unlock = lockInputToHost(host);

    let sawEscape = false;
    const onKeydown = (e) => { if (e.key === "Escape") sawEscape = true; };
    document.addEventListener("keydown", onKeydown);

    const evt = keydown("Escape");
    outsideBtn.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
    expect(sawEscape).toBe(true);

    document.removeEventListener("keydown", onKeydown);
    unlock();
  });

  it("allowKey still blocks the leak but lets the modal's own handler see the key", () => {
    const host = document.createElement("div");
    const outsideBtn = document.createElement("button");
    document.body.append(host, outsideBtn);
    const unlock = lockInputToHost(host, (e) => e.key === "j");

    let sawJ = false;
    const onKeydown = (e) => { if (e.key === "j") sawJ = true; };
    document.addEventListener("keydown", onKeydown);

    const evt = keydown("j");
    outsideBtn.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    expect(sawJ).toBe(true);

    document.removeEventListener("keydown", onKeydown);
    unlock();
  });

  it("stacks: a nested host's own elements aren't swallowed by an outer host's guard", () => {
    const outerHost = document.createElement("div");
    document.body.appendChild(outerHost);
    const unlockOuter = lockInputToHost(outerHost);

    // e.g. askConfirm opened from inside another guarded modal's flow.
    const innerHost = document.createElement("div");
    const innerBtn = document.createElement("button");
    innerHost.appendChild(innerBtn);
    document.body.appendChild(innerHost);
    const unlockInner = lockInputToHost(innerHost);

    let leaked = false;
    const onKeydown = () => { leaked = true; };
    document.addEventListener("keydown", onKeydown);

    const evt = keydown("a");
    innerBtn.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
    expect(leaked).toBe(true);

    document.removeEventListener("keydown", onKeydown);
    unlockInner();
    unlockOuter();
  });

  it("isAnyModalOpen reflects the lock stack", () => {
    expect(isAnyModalOpen()).toBe(false);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const unlock = lockInputToHost(host);
    expect(isAnyModalOpen()).toBe(true);
    unlock();
    expect(isAnyModalOpen()).toBe(false);
  });
});

describe("shortcuts.ts dispatcher gate", () => {
  it("does not fire a global shortcut while a modal holds the lock", async () => {
    const fired = [];
    register("new-chat", () => fired.push("new-chat"));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    const host = document.createElement("div");
    document.body.appendChild(host);
    const unlock = lockInputToHost(host);

    document.dispatchEvent(keydown("n", { ctrlKey: true }));
    expect(fired).toEqual([]);

    unlock();
    document.dispatchEvent(keydown("n", { ctrlKey: true }));
    expect(fired).toEqual(["new-chat"]);

    unregister("new-chat");
  });

  it("blocks an Escape-bound shortcut too, though the guard itself lets Escape pass", async () => {
    // Rebind a context-free shortcut to Escape: proves shortcuts.ts's own
    // modal-open check works, not just modal.ts's stopPropagation side effect.
    setBinding("new-chat", "escape");
    const fired = [];
    register("new-chat", () => fired.push("new-chat"));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    const host = document.createElement("div");
    document.body.appendChild(host);
    const unlock = lockInputToHost(host);

    document.dispatchEvent(keydown("Escape"));
    expect(fired).toEqual([]);

    unlock();
    unregister("new-chat");
    resetBinding("new-chat");
  });
});
