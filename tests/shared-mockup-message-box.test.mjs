// @vitest-environment jsdom
// asserts: src/views/sessions/shared-mockup-message.ts

// The Alt-click message box on the shared mockup: Escape still closes it after a
// send, and a second click while a send is in flight leaves the box alone.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { ElementMessenger } = await import("../src/views/sessions/shared-mockup-message.ts");

let root;
let frame;
let messenger;
let send;

function mount(sendImpl) {
  root = document.createElement("div");
  document.body.appendChild(root);
  frame = document.createElement("iframe");
  root.appendChild(frame);
  send = vi.fn(sendImpl);
  messenger = new ElementMessenger(root, {
    frame: () => frame,
    snapshot: () => ({ id: "pv-1", shared: true }),
    send,
  });
}

function altClick(region) {
  window.dispatchEvent(new MessageEvent("message", { data: { cc: "element", region, x: 10, y: 10 }, source: frame.contentWindow }));
}

const settle = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("the shared mockup message box", () => {
  it("keeps focus in the box after a send, so Escape still closes it", async () => {
    mount(async () => ({ target_name: "Layout" }));
    altClick("shell");
    const box = root.querySelector(".pvm-box");
    const ta = box.querySelector("textarea");
    ta.value = "make it blue";
    box.querySelector("[data-send]").click();
    await settle();

    expect(box.querySelector(".pvm-status").textContent).toBe("Sent to Layout.");
    // A disabled control cannot hold focus, which is what took Escape away.
    expect(ta.disabled).toBe(false);
    expect(document.activeElement).toBe(ta);
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(root.querySelector(".pvm-box")).toBeNull();
    messenger.destroy();
  });

  it("does not take a sent message's text back: the box reads as done and cannot send again", async () => {
    mount(async () => ({ target_name: "Layout" }));
    altClick("shell");
    const box = root.querySelector(".pvm-box");
    box.querySelector("textarea").value = "once";
    box.querySelector("[data-send]").click();
    await settle();
    expect(box.querySelector("textarea").value).toBe("");
    expect(box.querySelector("[data-send]").disabled).toBe(true);
    messenger.destroy();
  });

  it("ignores a second Alt-click while a send is in flight instead of rebuilding the box", async () => {
    let release;
    mount(() => new Promise((r) => { release = r; }));
    altClick("shell");
    const box = root.querySelector(".pvm-box");
    const ta = box.querySelector("textarea");
    ta.value = "first";
    box.querySelector("[data-send]").click();
    expect(send).toHaveBeenCalledTimes(1);

    altClick("hero");
    // The same textarea node, still holding the text and still showing the send.
    expect(root.querySelector(".pvm-box textarea")).toBe(ta);
    expect(ta.value).toBe("first");
    expect(root.querySelector(".pvm-status").textContent).toBe("Sending...");
    expect(root.querySelector(".pvm-to").textContent).toBe("To: page layout");

    release({ target_name: "Layout" });
    await settle();
    expect(root.querySelector(".pvm-status").textContent).toBe("Sent to Layout.");

    // Once the send has resolved a new click opens a working box for the new element.
    altClick("hero");
    const next = root.querySelector(".pvm-box");
    expect(next.querySelector(".pvm-to").textContent).toBe("To: hero region");
    next.querySelector("textarea").value = "second";
    send.mockImplementation(async () => ({ target_name: "Hero" }));
    next.querySelector("[data-send]").click();
    await settle();
    expect(send).toHaveBeenLastCalledWith("pv-1", "hero", "second");
    messenger.destroy();
  });
});
