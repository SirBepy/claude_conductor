// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/views/sessions/fab-dial.css", () => ({}));
vi.mock("../src/views/sessions/ask-panel", () => ({ mountAskPanel: () => ({ setCwd() {}, setSessionScope() {}, destroy() {} }) }));
vi.mock("../src/views/sessions/todos-panel", () => ({ mountTodosPanel: () => ({ setSessionScope() {}, destroy() {} }) }));
vi.mock("../src/views/sessions/drafts-panel", () => ({ mountDraftsPanel: () => ({ setSessionScope() {}, destroy() {} }) }));

const { mountFabDial } = await import("../src/views/sessions/fab-dial.ts");

describe("fab dial survives a pane rebuild", () => {
  let pane;
  beforeEach(() => {
    document.body.innerHTML = "";
    pane = document.createElement("div");
    document.body.appendChild(pane);
  });

  it("mounts a host once a session is scoped", () => {
    const fab = mountFabDial(pane, { onDraft() {}, preview: null });
    fab.setSessionScope("sess-A", "C:/repo");
    expect(pane.querySelector(".fab-dial-host")).not.toBeNull();
    expect(pane.querySelector("[data-fab-toggle]")).not.toBeNull();
  });

  // selectSession / renderPendingPane both rewrite pane.innerHTML AFTER
  // setSessionScope has run, which orphans the host - the reason the dial was
  // invisible in the shipped app despite being mounted.
  it("reattaches after pane.innerHTML wipes it", () => {
    const fab = mountFabDial(pane, { onDraft() {}, preview: null });
    fab.setSessionScope("sess-A", "C:/repo");

    pane.innerHTML = `<div class="session-messages"></div>`;
    expect(pane.querySelector(".fab-dial-host")).toBeNull();

    fab.reattach();
    expect(pane.querySelector(".fab-dial-host")).not.toBeNull();
    expect(pane.querySelectorAll("[data-dial]").length).toBe(4);
  });

  it("stays gone when no session is scoped", () => {
    const fab = mountFabDial(pane, { onDraft() {}, preview: null });
    fab.setSessionScope(null, null);
    fab.reattach();
    expect(pane.querySelector(".fab-dial-host")).toBeNull();
  });
});
