// @vitest-environment jsdom
// Regression cover for the two pop-out dead ends Joe hit on 2026-09-23: the
// window-mode expand button that did nothing, and the preview that became
// unreachable from both windows once the pop-out was closed.
import { describe, it, expect, beforeEach, vi } from "vitest";

const invokeCalls = [];
vi.mock("../src/shared/ipc", () => ({
  invoke: (cmd, args) => {
    invokeCalls.push({ cmd, args });
    return Promise.resolve();
  },
}));

const eventHandlers = new Map();
vi.mock("../src/shared/events", () => ({
  listen: (name, cb) => {
    eventHandlers.set(name, cb);
    return Promise.resolve(() => eventHandlers.delete(name));
  },
}));

vi.mock("../src/views/sessions/preview-panel-resize", () => ({
  wireResizeHandle: () => () => {},
  clampPanelWidth: (px) => px,
  splittableWidth: () => 1000,
}));

const { mountRail } = await import("../src/views/sessions/rail-panel.ts");

const stubTab = () => ({
  setSessionScope() {},
  refresh() {},
  closeMenus() {},
  destroy() {},
});

function mount(mode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const rail = mountRail(host, { mode, mountPreview: stubTab });
  return { host, rail };
}

/** The delegated handler lives on the host, so a bubbling click is the only
 *  faithful way to exercise the strip. */
function clickAct(host, act) {
  host.querySelector(`[data-act="${act}"]`).dispatchEvent(new Event("click", { bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  invokeCalls.length = 0;
  eventHandlers.clear();
});

describe("pop-out window is never a one-way door", () => {
  it("takes the rail back when the pop-out window reports it closed", async () => {
    const { host, rail } = mount("panel");
    rail.setSessionScope("sess-A");
    rail.open();
    expect(host.hidden).toBe(false);

    clickAct(host, "popout");
    expect(host.hidden).toBe(true);
    expect(localStorage.getItem("cc_preview_panel_popped:sess-A")).toBe("1");
    expect(invokeCalls.at(-1).cmd).toBe("open_preview_window");

    // Rust hides rather than destroys that window, so this event is the only
    // signal the docked rail ever gets - the bug was that nothing cleared the
    // flag and the rail stayed hidden forever.
    await Promise.resolve();
    eventHandlers.get("preview-window-docked")({ sessionId: "sess-A" });
    expect(localStorage.getItem("cc_preview_panel_popped:sess-A")).toBe("0");
    expect(host.hidden).toBe(false);
  });

  it("leaves the rail closed when the pop-out was dismissed, not relocated", async () => {
    const { host, rail } = mount("panel");
    rail.setSessionScope("sess-A");
    rail.open();
    clickAct(host, "popout");

    // What window mode's X writes before asking for the close.
    localStorage.setItem("cc_preview_panel_open:sess-A", "0");
    localStorage.setItem("cc_preview_panel_popped:sess-A", "0");

    await Promise.resolve();
    eventHandlers.get("preview-window-docked")({ sessionId: "sess-A" });
    expect(host.hidden).toBe(true);
    expect(rail.isOpen()).toBe(false);
  });

  it("clears a popped flag for a chat that is not the current one", async () => {
    const { rail } = mount("panel");
    rail.setSessionScope("sess-A");
    localStorage.setItem("cc_preview_panel_popped:sess-B", "1");

    await Promise.resolve();
    eventHandlers.get("preview-window-docked")({ sessionId: "sess-B" });
    expect(localStorage.getItem("cc_preview_panel_popped:sess-B")).toBe("0");
  });

  it("surfaces the pop-out window instead of going inert when the dial is hit", () => {
    const { host, rail } = mount("panel");
    rail.setSessionScope("sess-A");
    rail.open();
    clickAct(host, "popout");
    invokeCalls.length = 0;

    // Used to flip openState to false and hide an already-hidden host, so the
    // next press bailed on the popped flag and preview was gone for good.
    rail.toggle();
    expect(invokeCalls.map((c) => c.cmd)).toEqual(["open_preview_window"]);
    expect(host.hidden).toBe(true);
  });
});

describe("window-mode strip", () => {
  it("offers a live restore button, not a dead hidden one", () => {
    const { host, rail } = mount("window");
    rail.setSessionScope("sess-A");

    expect(host.querySelector('[data-act="popout"]')).toBeNull();
    const restore = host.querySelector('[data-act="restore"]');
    expect(restore).not.toBeNull();
    // `.icon-btn-sq { display: grid }` beats the UA [hidden] rule, so a hidden
    // attribute here would render a visible, dead button.
    expect(restore.hasAttribute("hidden")).toBe(false);
  });

  it("restore docks back without closing the preview", () => {
    const { host, rail } = mount("window");
    rail.setSessionScope("sess-A");
    localStorage.setItem("cc_preview_panel_open:sess-A", "1");
    localStorage.setItem("cc_preview_panel_popped:sess-A", "1");

    clickAct(host, "restore");
    expect(localStorage.getItem("cc_preview_panel_popped:sess-A")).toBe("0");
    expect(localStorage.getItem("cc_preview_panel_open:sess-A")).toBe("1");
    expect(invokeCalls.at(-1).cmd).toBe("close_preview_window");
  });

  it("X closes the preview outright", () => {
    const { host, rail } = mount("window");
    rail.setSessionScope("sess-A");
    localStorage.setItem("cc_preview_panel_open:sess-A", "1");
    localStorage.setItem("cc_preview_panel_popped:sess-A", "1");

    clickAct(host, "close");
    expect(localStorage.getItem("cc_preview_panel_popped:sess-A")).toBe("0");
    expect(localStorage.getItem("cc_preview_panel_open:sess-A")).toBe("0");
    expect(invokeCalls.at(-1).cmd).toBe("close_preview_window");
  });
});
