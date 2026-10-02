// @vitest-environment jsdom
//
// Todo 988: render() snapshots each .sb-row's scrollLeft before the innerHTML
// rebuild and restores it right after. In a real browser that restore can
// clamp to 0 (Playwright: "Expected 40, Received 0") because the freshly
// rebuilt row's scrollable width isn't established yet at write time.
//
// jsdom does no layout: scrollWidth/clientWidth are always 0 and scrollLeft
// is never clamped, so the clamp itself cannot be reproduced here (confirmed:
// `el.scrollLeft = 40` round-trips to 40 in jsdom regardless of layout
// state). This test can only pin the ORDERING of the fix - that render()
// reads a layout-dependent property on each row before writing its restored
// scrollLeft - not prove the clamp is gone in a real engine. The Playwright
// spec (e2e/view-harness/statusbar-scroll-fade.view.spec.ts) is what proves
// that.

import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMock = { impl: async () => null };
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn((cmd, args) => ipcMock.impl(cmd, args)),
}));

const { SessionStatusbar } = await import("../src/views/sessions/session-statusbar.ts");

const CLOCK_ROW = [["clock"]]; // always renders a chip, independent of tally state

function mount(rows = CLOCK_ROW, opts = {}) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const sb = new SessionStatusbar(el, null, rows, { sessionId: "sess-1", hideZero: true, ...opts });
  return { el, sb };
}

beforeEach(() => {
  ipcMock.impl = async () => null;
  document.body.innerHTML = "";
});

describe("statusbar scroll restore ordering (todo 988)", () => {
  it("reads a layout-dependent property on the row before writing the restored scrollLeft", () => {
    const { el, sb } = mount();
    const row = el.querySelector(".sb-row");
    row.scrollLeft = 40;

    const events = [];
    const offsetWidthSpy = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function () {
      if (this.classList?.contains("sb-row")) events.push("read-offsetWidth");
      return 0;
    });
    const nativeDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollLeft")
      ?? Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollLeft");
    const scrollLeftSpy = vi.spyOn(HTMLElement.prototype, "scrollLeft", "set").mockImplementation(function (v) {
      events.push("write-scrollLeft");
      nativeDescriptor.set.call(this, v);
    });

    // Any public updater re-runs the full render()/innerHTML rebuild path.
    sb.setAccountId("acct-x");

    offsetWidthSpy.mockRestore();
    scrollLeftSpy.mockRestore();

    expect(events).toContain("read-offsetWidth");
    expect(events).toContain("write-scrollLeft");
    expect(events.indexOf("read-offsetWidth")).toBeLessThan(events.indexOf("write-scrollLeft"));
  });
});
