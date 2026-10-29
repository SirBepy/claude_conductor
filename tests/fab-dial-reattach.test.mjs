// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/views/sessions/fab-dial.css", () => ({}));
vi.mock("../src/views/sessions/ask-panel", () => ({ mountAskPanel: () => ({ setCwd() {}, setSessionScope() {}, destroy() {} }) }));
vi.mock("../src/views/sessions/todos-panel", () => ({ mountTodosPanel: () => ({ setSessionScope() {}, destroy() {} }) }));
vi.mock("../src/views/sessions/drafts-panel", () => ({ mountDraftsPanel: () => ({ setSessionScope() {}, destroy() {} }) }));
const backlogRoots = vi.hoisted(() => []);
vi.mock("../src/views/sessions/backlog-panel/backlog-panel", () => ({
  mountBacklogPanel: (root) => {
    backlogRoots.push(root);
    return { setSessionScope() {}, refresh() {}, destroy() {} };
  },
}));

const stubPreview = () => ({ setSessionScope() {}, refresh() {}, closeMenus() {}, destroy() {} });
const { mountFabDial } = await import("../src/views/sessions/fab-dial.ts");

// jsdom has no matchMedia, which fab-dial reads as "desktop": the phone path is
// the one that owns the FAB, so these tests pose as a narrow window.
// A desktop window is also Tauri (isRemote() is false there).
const setNarrow = (narrow) => {
  if (narrow) delete window.__TAURI__;
  else window.__TAURI__ = {};
  window.matchMedia = () => ({ matches: narrow, addEventListener() {}, removeEventListener() {} });
};

describe("fab dial survives a pane rebuild", () => {
  let pane;
  beforeEach(() => {
    setNarrow(true);
    document.body.innerHTML = "";
    pane = document.createElement("div");
    document.body.appendChild(pane);
  });

  it("mounts a host once a session is scoped", () => {
    const fab = mountFabDial(pane, { onDraft() {}, onCode() {}, mountPreview: stubPreview });
    fab.setSessionScope("sess-A", "C:/repo");
    expect(pane.querySelector(".fab-dial-host")).not.toBeNull();
    expect(pane.querySelector("[data-fab-toggle]")).not.toBeNull();
  });

  // selectSession / renderPendingPane both rewrite pane.innerHTML AFTER
  // setSessionScope has run, which orphans the host - the reason the dial was
  // invisible in the shipped app despite being mounted.
  it("reattaches after pane.innerHTML wipes it", () => {
    const fab = mountFabDial(pane, { onDraft() {}, onCode() {}, mountPreview: stubPreview });
    fab.setSessionScope("sess-A", "C:/repo");

    pane.innerHTML = `<div class="session-messages"></div>`;
    expect(pane.querySelector(".fab-dial-host")).toBeNull();

    fab.reattach();
    expect(pane.querySelector(".fab-dial-host")).not.toBeNull();
    expect(pane.querySelectorAll("[data-dial]").length).toBe(6);
  });

  it("stays gone when no session is scoped", () => {
    const fab = mountFabDial(pane, { onDraft() {}, onCode() {}, mountPreview: stubPreview });
    fab.setSessionScope(null, null);
    fab.reattach();
    expect(pane.querySelector(".fab-dial-host")).toBeNull();
  });

  it("draws no FAB on desktop, where the split's strip already lists the panels", () => {
    setNarrow(false);
    const fab = mountFabDial(pane, { onDraft() {}, onCode() {}, mountPreview: stubPreview });
    fab.setSessionScope("sess-A", "C:/repo");
    expect(pane.querySelector("[data-fab-toggle]")).toBeNull();
    expect(pane.querySelector("[data-dial]")).toBeNull();
  });

  it("puts Code at the top of the desktop strip and fires onCode", () => {
    setNarrow(false);
    const onCode = vi.fn();
    const fab = mountFabDial(pane, { onDraft() {}, onCode, mountPreview: stubPreview });
    fab.setSessionScope("sess-A", "C:/repo");
    const tabs = pane.querySelectorAll(".sp-strip .sp-tab");
    expect(tabs[0].hasAttribute("data-sp-code")).toBe(true);
    tabs[0].click();
    expect(onCode).toHaveBeenCalledTimes(1);
  });

  // The phone's todos chip dispatches cc-backlog-open, which sessions.ts routes
  // to openPanel("backlog"); without it the chip would do nothing.
  it("openPanel('backlog') brings the Backlog panel's window up", () => {
    const fab = mountFabDial(pane, { onDraft() {}, onCode() {}, mountPreview: stubPreview });
    fab.setSessionScope("sess-A", "C:/repo");
    const shown = () => [...pane.querySelectorAll(".pw-window")].filter((w) => !w.hidden);
    expect(shown()).toHaveLength(0);

    fab.openPanel("backlog");

    const open = shown();
    expect(open).toHaveLength(1);
    expect(open[0].dataset.active).toBe("backlog");
    expect(open[0].querySelector('[data-panel="backlog"]')).not.toBeNull();
    expect(backlogRoots.some((r) => open[0].contains(r))).toBe(true);
  });
});
