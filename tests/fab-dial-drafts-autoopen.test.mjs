// @vitest-environment jsdom
// todo 951: a reply Claude wrote for Joe to send elsewhere never showed up -
// the FAB only ever refreshed Drafts if the card was already open, so a brand
// new draft was invisible. These pin the open's scope, which is the part that
// makes it tolerable: only an `add`, only the chat on screen, never over a card
// he opened himself.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/views/sessions/fab-dial.css", () => ({}));
vi.mock("../src/views/sessions/ask-panel", () => ({
  mountAskPanel: () => ({ setCwd() {}, setSessionScope() {}, destroy() {} }),
}));
vi.mock("../src/views/sessions/todos-panel", () => ({
  mountTodosPanel: () => ({ setSessionScope() {}, destroy() {} }),
}));

const opened = [];
vi.mock("../src/views/sessions/drafts-panel", () => ({
  mountDraftsPanel: () => ({
    setSessionScope() {},
    openDraft(id) { opened.push(id); },
    refresh() {},
    destroy() {},
  }),
}));

const listeners = new Map();
vi.mock("../src/shared/transport", () => ({
  getTransport: () => ({
    async listen(event, cb) {
      const set = listeners.get(event) ?? new Set();
      set.add(cb);
      listeners.set(event, set);
      return () => set.delete(cb);
    },
  }),
}));

const { mountFabDial } = await import("../src/views/sessions/fab-dial.ts");

/** The constructor's listen() is awaited, so the callback lands a microtask
 *  after mount - firing before this resolves would hit an empty listener set. */
const settle = () => new Promise((r) => setTimeout(r, 0));
const fire = (payload) => {
  for (const cb of listeners.get("message-drafts-changed") ?? []) cb(payload);
};
const onDrafts = (pane) => !!pane.querySelector('[data-spine="drafts"].on');

describe("a new draft opens the FAB's Drafts card", () => {
  let pane;
  let fab;

  beforeEach(async () => {
    document.body.innerHTML = "";
    opened.length = 0;
    listeners.clear();
    pane = document.createElement("div");
    document.body.appendChild(pane);
    fab = mountFabDial(pane, { onDraft() {}, preview: null });
    fab.setSessionScope("sess-A", "C:/repo");
    await settle();
  });

  it("opens onto the draft Claude just wrote in this chat", () => {
    fire({ project_id: "p1", added: { id: "d-1", origin_session_id: "sess-A" } });
    expect(onDrafts(pane)).toBe(true);
    expect(opened).toEqual(["d-1"]);
  });

  it("ignores a revise, a state flip or Joe's own edit", () => {
    // Every mutation but `add` publishes the bare event.
    fire({ project_id: "p1" });
    expect(onDrafts(pane)).toBe(false);
    expect(opened).toEqual([]);
  });

  it("never forces a switch out of a background chat's draft", () => {
    fire({ project_id: "p1", added: { id: "d-2", origin_session_id: "sess-B" } });
    expect(onDrafts(pane)).toBe(false);
    expect(opened).toEqual([]);
  });

  it("leaves a card he opened himself alone", () => {
    pane.querySelector("[data-fab-toggle]").click();
    pane.querySelector('[data-dial="ask"]').click();
    expect(pane.querySelector('[data-spine="ask"].on')).not.toBeNull();

    fire({ project_id: "p1", added: { id: "d-3", origin_session_id: "sess-A" } });
    expect(pane.querySelector('[data-spine="ask"].on')).not.toBeNull();
    expect(onDrafts(pane)).toBe(false);
    expect(opened).toEqual([]);
  });

  it("drops a pending open when the chat changes under it", () => {
    fab.setSessionScope("sess-B", "C:/repo");
    fire({ project_id: "p1", added: { id: "d-4", origin_session_id: "sess-A" } });
    expect(onDrafts(pane)).toBe(false);
    expect(opened).toEqual([]);
  });
});
