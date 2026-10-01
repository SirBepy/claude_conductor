// @vitest-environment jsdom
// Preview's pop-out is never a one-way door (Joe, 2026-09-23): closing the
// pop-out OS window must hand Preview back to the chat window, dismissing it
// must not, and the dial must surface a popped-out Preview instead of going
// inert. Preview now lives in a pane window (pane-windows/manager.ts); the
// pop-out keeps the strip in rail-panel.ts.
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

const stubPanel = () => ({ setSessionScope() {}, setCwd() {}, refresh() {}, destroy() {}, openDraft() {} });
vi.mock("../src/views/sessions/ask-panel", () => ({ mountAskPanel: stubPanel }));
vi.mock("../src/views/sessions/todos-panel", () => ({ mountTodosPanel: stubPanel }));
vi.mock("../src/views/sessions/drafts-panel", () => ({ mountDraftsPanel: stubPanel }));

const { PaneWindows } = await import("../src/views/sessions/pane-windows/manager.ts");
const { mountPreviewWindowShell } = await import("../src/views/sessions/rail-panel.ts");

const stubTab = () => ({ setSessionScope() {}, refresh() {}, closeMenus() {}, destroy() {} });

function mountPane() {
  const pane = document.createElement("div");
  const layer = document.createElement("div");
  pane.appendChild(layer);
  document.body.appendChild(pane);
  const windows = new PaneWindows(pane, layer, { onDraft() {}, mountPreview: stubTab, onChange() {} });
  windows.setSessionScope("sess-A", "/repo");
  return { layer, windows, preview: windows.previewController() };
}

const previewWindow = (layer) => layer.querySelector('.pw-window[data-active="preview"]');

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  invokeCalls.length = 0;
  eventHandlers.clear();
});

describe("pop-out window is never a one-way door", () => {
  it("takes Preview back when the pop-out window reports it closed", async () => {
    const { layer, preview } = mountPane();
    preview.open();
    expect(previewWindow(layer).hidden).toBe(false);

    preview.popOut();
    expect(previewWindow(layer).hidden).toBe(true);
    expect(localStorage.getItem("cc_preview_panel_popped:sess-A")).toBe("1");
    expect(invokeCalls.at(-1).cmd).toBe("open_preview_window");

    // Rust hides rather than destroys that window, so this event is the only
    // signal the chat window ever gets.
    await Promise.resolve();
    eventHandlers.get("preview-window-docked")({ sessionId: "sess-A" });
    expect(localStorage.getItem("cc_preview_panel_popped:sess-A")).toBe("0");
    expect(previewWindow(layer).hidden).toBe(false);
  });

  it("leaves Preview closed when the pop-out was dismissed, not relocated", async () => {
    const { layer, preview } = mountPane();
    preview.open();
    preview.popOut();

    // What the pop-out's X writes before asking for the close.
    localStorage.setItem("cc_preview_panel_open:sess-A", "0");
    localStorage.setItem("cc_preview_panel_popped:sess-A", "0");

    await Promise.resolve();
    eventHandlers.get("preview-window-docked")({ sessionId: "sess-A" });
    expect(previewWindow(layer).hidden).toBe(true);
    expect(preview.isOpen()).toBe(false);
  });

  it("clears a popped flag for a chat that is not the current one", async () => {
    mountPane();
    localStorage.setItem("cc_preview_panel_popped:sess-B", "1");

    await Promise.resolve();
    eventHandlers.get("preview-window-docked")({ sessionId: "sess-B" });
    expect(localStorage.getItem("cc_preview_panel_popped:sess-B")).toBe("0");
  });

  it("surfaces the pop-out window instead of going inert when the dial is hit", () => {
    const { layer, preview } = mountPane();
    preview.open();
    preview.popOut();
    invokeCalls.length = 0;

    preview.toggle();
    expect(invokeCalls.map((c) => c.cmd)).toEqual(["open_preview_window"]);
    expect(previewWindow(layer).hidden).toBe(true);
  });

  it("a background chat's push opens that chat's Preview next time it is shown", () => {
    const { windows, layer } = mountPane();
    localStorage.setItem("cc_preview_panel_open:sess-B", "1");
    windows.setSessionScope("sess-B", "/repo");
    expect(previewWindow(layer).hidden).toBe(false);
  });
});

describe("pop-out window strip", () => {
  function mountShell() {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shell = mountPreviewWindowShell(host, stubTab);
    shell.setSessionScope("sess-A");
    return host;
  }
  const clickAct = (host, act) =>
    host.querySelector(`[data-act="${act}"]`).dispatchEvent(new Event("click", { bubbles: true }));

  it("offers a live restore button, not a dead hidden one", () => {
    const host = mountShell();
    expect(host.querySelector('[data-act="popout"]')).toBeNull();
    const restore = host.querySelector('[data-act="restore"]');
    expect(restore).not.toBeNull();
    // `.icon-btn-sq { display: grid }` beats the UA [hidden] rule, so a hidden
    // attribute here would render a visible, dead button.
    expect(restore.hasAttribute("hidden")).toBe(false);
  });

  it("restore docks back without closing the preview", () => {
    const host = mountShell();
    localStorage.setItem("cc_preview_panel_open:sess-A", "1");
    localStorage.setItem("cc_preview_panel_popped:sess-A", "1");

    clickAct(host, "restore");
    expect(localStorage.getItem("cc_preview_panel_popped:sess-A")).toBe("0");
    expect(localStorage.getItem("cc_preview_panel_open:sess-A")).toBe("1");
    expect(invokeCalls.at(-1).cmd).toBe("close_preview_window");
  });

  it("X closes the preview outright", () => {
    const host = mountShell();
    localStorage.setItem("cc_preview_panel_open:sess-A", "1");
    localStorage.setItem("cc_preview_panel_popped:sess-A", "1");

    clickAct(host, "close");
    expect(localStorage.getItem("cc_preview_panel_popped:sess-A")).toBe("0");
    expect(localStorage.getItem("cc_preview_panel_open:sess-A")).toBe("0");
    expect(invokeCalls.at(-1).cmd).toBe("close_preview_window");
  });
});
