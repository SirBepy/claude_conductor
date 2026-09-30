// @vitest-environment jsdom
// todo 1023: drag/drop reorder, the hide-zero checkbox, clear and reset all
// persist via updateSettings (loadStatuslineRows/saveStatuslineRows etc.),
// which the daemon refuses from the phone - the builder renders read-only
// there instead.

import { describe, it, expect, vi, beforeEach } from "vitest";

const store = { settings: {} };
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn(async (cmd, args) => {
    if (cmd === "get_settings") return { ...store.settings };
    if (cmd === "save_settings") { store.settings = { ...args.updated }; return null; }
    return null;
  }),
}));

let mobile = false;
vi.mock("../src/shared/mobile-viewport.ts", () => ({
  MOBILE_MQ: "(max-width: 768px)",
  isMobileViewport: () => mobile,
  onMobileViewportChange: () => () => {},
}));

let remote = false;
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => remote }));

const { renderStatuslineView } = await import(
  "../src/views/settings/subviews/statusline/statusline.ts"
);

beforeEach(() => { store.settings = {}; mobile = false; remote = false; document.body.innerHTML = ""; });

describe("statusline builder on the phone", () => {
  it("renders the chip layout read-only when remote", async () => {
    remote = true;
    const root = document.createElement("div");
    document.body.appendChild(root);
    const dispose = await renderStatuslineView(root);

    // No editing affordances at all.
    expect(root.querySelector("#slPalette")).toBeNull();
    expect(root.querySelector("#slHideZero")).toBeNull();
    expect(root.querySelector("#slClearBtn")).toBeNull();
    expect(root.querySelector("#slResetBtn")).toBeNull();
    expect(root.querySelector("#slAddRow")).toBeNull();
    expect(root.querySelector(".sl-row-btn")).toBeNull();
    // No drag pointerdown wiring on the placed chips either.
    const chip = root.querySelector(".sl-placed");
    expect(chip).not.toBeNull();
    const evt = new Event("pointerdown", { bubbles: true, cancelable: true });
    chip.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
    // The bar itself, and the desktop/mobile screen switch, stay visible.
    expect(root.querySelector("#slBar")).not.toBeNull();
    expect(root.querySelector("#slRowsHint").textContent).toContain("desktop app");

    dispose();
  });

  it("keeps every editing control when not remote", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const dispose = await renderStatuslineView(root);

    expect(root.querySelector("#slPalette")).not.toBeNull();
    expect(root.querySelector("#slHideZero")).not.toBeNull();
    expect(root.querySelector("#slClearBtn")).not.toBeNull();
    expect(root.querySelector("#slResetBtn")).not.toBeNull();

    dispose();
  });
});
