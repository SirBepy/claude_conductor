// @vitest-environment jsdom
//
// The header chip (src/views/sessions/when-done-chip.ts): shown only while a
// run is armed, one-click postpone during the countdown, a preset popover
// otherwise, and not rebuilt on every 1s countdown tick (its popover anchor
// would be replaced under an open popover).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mountWhenDoneChip } from "../src/views/sessions/when-done-chip.ts";
import { initWhenDone } from "../src/views/sessions/when-done.ts";
import { state } from "../src/views/sessions/state.ts";

let invokeCalls;
let eventCb;
let nextReturn;

function ps(overrides = {}) {
  return {
    action: null,
    phase: "disarmed",
    countdown_remaining_secs: null,
    waiting_on: [],
    gave_up_reason: null,
    snoozed_until_unix_ms: null,
    ...overrides,
  };
}

let root;
let teardownWhenDone;
let disposeChip;

beforeEach(async () => {
  invokeCalls = [];
  nextReturn = ps();
  state.whenDone = null;
  globalThis.window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        invokeCalls.push({ cmd, args });
        return nextReturn;
      },
    },
    event: {
      listen: async (_n, cb) => {
        eventCb = cb;
        return () => {};
      },
    },
  };
  document.body.innerHTML = `<div id="root"><span id="when-done-chip-host" hidden></span></div>`;
  root = document.getElementById("root");
  teardownWhenDone = await initWhenDone();
  disposeChip = mountWhenDoneChip(root);
});

afterEach(() => {
  disposeChip();
  teardownWhenDone();
  document.body.innerHTML = "";
});

const host = () => root.querySelector("#when-done-chip-host");
const push = (s) => eventCb({ payload: s });

describe("when-done header chip", () => {
  it("stays hidden until a run is armed, then shows it, then hides again", () => {
    expect(host().hidden).toBe(true);
    push(ps({ action: "shutdown", phase: "watching", waiting_on: ["a"] }));
    expect(host().hidden).toBe(false);
    expect(host().textContent).toContain("Shutdown when idle · 1 chat");
    push(ps());
    expect(host().hidden).toBe(true);
    expect(host().innerHTML).toBe("");
  });

  it("switching the armed action while armed swaps the icon along with the text", () => {
    push(ps({ action: "sleep", phase: "watching" }));
    expect(host().querySelector("i").className).toContain("ph-moon-stars");
    push(ps({ action: "shutdown", phase: "watching" }));
    expect(host().querySelector("i").className).toContain("ph-power");
    expect(host().textContent).toContain("Shutdown when idle");
  });

  it("the countdown chip has a one-click Postpone that snoozes 30 minutes", () => {
    push(ps({ action: "shutdown", phase: "countingDown", countdown_remaining_secs: 28 }));
    expect(host().textContent).toContain("Shutdown in 28s");
    invokeCalls.length = 0;
    host().querySelector("[data-when-done-quick]").click();
    expect(invokeCalls).toEqual([{ cmd: "snooze_when_done", args: { minutes: 30 } }]);
  });

  it("a countdown tick updates the text without replacing the chip element", () => {
    push(ps({ action: "shutdown", phase: "countingDown", countdown_remaining_secs: 28 }));
    const before = host().querySelector("[data-when-done-chip]");
    push(ps({ action: "shutdown", phase: "countingDown", countdown_remaining_secs: 27 }));
    expect(host().querySelector("[data-when-done-chip]")).toBe(before);
    expect(host().textContent).toContain("Shutdown in 27s");
  });

  it("clicking the chip opens the presets, and a preset snoozes that long", () => {
    push(ps({ action: "shutdown", phase: "watching" }));
    host().querySelector("[data-when-done-chip]").click();
    const items = [...document.querySelectorAll(".when-done-popover .smore-item")];
    expect(items.map((i) => i.textContent)).toEqual(["30 minutes", "1 hour", "3 hours", "Cancel"]);
    invokeCalls.length = 0;
    items[2].click();
    expect(invokeCalls).toEqual([{ cmd: "snooze_when_done", args: { minutes: 180 } }]);
    expect(document.querySelector(".when-done-popover")).toBe(null);
  });

  it("Cancel in the popover cancels the run", () => {
    push(ps({ action: "sleep", phase: "watching" }));
    host().querySelector("[data-when-done-chip]").click();
    invokeCalls.length = 0;
    document.querySelector(".when-done-popover-cancel").click();
    expect(invokeCalls).toEqual([{ cmd: "cancel_when_done", args: undefined }]);
  });

  it("firing has no click target", () => {
    push(ps({ action: "shutdown", phase: "firing" }));
    expect(host().textContent).toContain("Shutdown now...");
    expect(host().querySelector("button")).toBe(null);
  });
});
