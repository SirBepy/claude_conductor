// @vitest-environment jsdom
// todo 835: 1-9 selects the Nth option a modal registers via
// registerSelectableOptions. Typing a digit into the modal's own text field
// must still type it; 834's leak fix stays covered separately.

import { describe, it, expect, afterEach } from "vitest";
import { lockInputToHost, registerSelectableOptions } from "../src/shared/modal-input-lock.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

function keydown(key, extra = {}) {
  return new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
}

function makeOptions(host, count) {
  const opts = [];
  for (let i = 0; i < count; i++) {
    const btn = document.createElement("button");
    let clicked = false;
    btn.addEventListener("click", () => { clicked = true; });
    Object.defineProperty(btn, "wasClicked", { get: () => clicked });
    host.appendChild(btn);
    opts.push(btn);
  }
  return opts;
}

describe("registerSelectableOptions + number-key select", () => {
  it("activates the Nth option when the target sits outside the host", () => {
    const host = document.createElement("div");
    const outsideBtn = document.createElement("button");
    document.body.append(host, outsideBtn);
    const opts = makeOptions(host, 3);
    registerSelectableOptions(host, () => opts);
    const unlock = lockInputToHost(host);

    const evt = keydown("2");
    outsideBtn.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    expect(opts[1].wasClicked).toBe(true);
    expect(opts[0].wasClicked).toBe(false);
    expect(opts[2].wasClicked).toBe(false);

    unlock();
  });

  it("still swallows the leak when the pressed digit has no matching option", () => {
    const host = document.createElement("div");
    const outsideBtn = document.createElement("button");
    document.body.append(host, outsideBtn);
    const opts = makeOptions(host, 2);
    registerSelectableOptions(host, () => opts);
    const unlock = lockInputToHost(host);

    let leaked = false;
    const onKeydown = () => { leaked = true; };
    document.addEventListener("keydown", onKeydown);

    const evt = keydown("5"); // out of range: only 2 options registered
    outsideBtn.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    expect(leaked).toBe(false);

    document.removeEventListener("keydown", onKeydown);
    unlock();
  });

  it("activates the Nth option when focus sits inside the host on a non-editable element", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const opts = makeOptions(host, 3);
    registerSelectableOptions(host, () => opts);
    const unlock = lockInputToHost(host);

    opts[0].dispatchEvent(keydown("3")); // dispatched from the first button, still inside the host
    expect(opts[2].wasClicked).toBe(true);

    unlock();
  });

  it("leaves a digit typed into the modal's own text input alone - it still types", () => {
    const host = document.createElement("div");
    const input = document.createElement("input");
    host.appendChild(input);
    document.body.appendChild(host);
    const opts = makeOptions(host, 3);
    registerSelectableOptions(host, () => opts);
    const unlock = lockInputToHost(host);

    const evt = keydown("2");
    input.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
    expect(opts.some((o) => o.wasClicked)).toBe(false);

    unlock();
  });

  it("only the topmost (most recently locked) host's options respond when stacked", () => {
    const outerHost = document.createElement("div");
    document.body.appendChild(outerHost);
    const outerOpts = makeOptions(outerHost, 2);
    registerSelectableOptions(outerHost, () => outerOpts);
    const unlockOuter = lockInputToHost(outerHost);

    const innerHost = document.createElement("div");
    document.body.appendChild(innerHost);
    const innerOpts = makeOptions(innerHost, 2);
    registerSelectableOptions(innerHost, () => innerOpts);
    const unlockInner = lockInputToHost(innerHost);

    document.body.dispatchEvent(keydown("1")); // target outside both hosts
    expect(innerOpts[0].wasClicked).toBe(true);
    expect(outerOpts[0].wasClicked).toBe(false);

    unlockInner();
    unlockOuter();
  });

  it("a modal that never registers options (opted out) leaves the digit swallowed but inert", () => {
    const host = document.createElement("div");
    const outsideBtn = document.createElement("button");
    document.body.append(host, outsideBtn);
    const unlock = lockInputToHost(host); // no registerSelectableOptions call - e.g. a form step

    const evt = keydown("2");
    outsideBtn.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true); // still leak-blocked by 834's trap

    unlock();
  });

  it("clears registered options once the host's lock releases", () => {
    const host = document.createElement("div");
    const outsideBtn = document.createElement("button");
    document.body.append(host, outsideBtn);
    const opts = makeOptions(host, 1);
    registerSelectableOptions(host, () => opts);
    const unlock = lockInputToHost(host);
    unlock();

    // Re-lock without re-registering: a stale getter must not resurrect.
    const unlock2 = lockInputToHost(host);
    outsideBtn.dispatchEvent(keydown("1"));
    expect(opts[0].wasClicked).toBe(false);
    unlock2();
  });
});
