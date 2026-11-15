// @vitest-environment jsdom
// asserts: src/views/sessions/shared-mockup-bar.ts

// The bar's working values follow the snapshot's saved view_state: a control value
// the daemon cleared (the page was re-pushed without it) stops being replayed into
// the frame, instead of lingering from an earlier render of the same page.

import { describe, it, expect, vi } from "vitest";

const { SharedBar } = await import("../src/views/sessions/shared-mockup-bar.ts");

const control = (id, kind, extra = {}) => ({ id, label: id, kind, options: [], default: kind === "switch" ? "off" : "", ...extra });
const snap = (viewState) => ({
  id: "shared-1", slug: "portfolio", title: "Portfolio", source: "chat", session_id: "main", version: 1, created_at: "2026-11-05T00:00:00.000Z", versions: [],
  html: "<p>page</p>",
  shared: {
    owner_session_id: "main",
    shell: "",
    parts: [{ id: "header", owner_session_id: "sub-hero", owner_name: "Hero", html: "", css: "", controls: [control("style", "select", { options: ["aurora", "ember"], default: "aurora" }), control("photo", "switch")] }],
  },
  view_state: viewState,
});

function mount() {
  const root = document.createElement("div");
  root.innerHTML = `<div class="pv-shared"></div>`;
  document.body.appendChild(root);
  const post = vi.fn();
  const bar = new SharedBar(root, {
    frame: () => ({ contentWindow: { postMessage: post } }),
    scope: () => null,
    dedicatedOf: () => [],
    open() {},
    persist() {},
  });
  return { bar, post };
}

describe("SharedBar saved control values", () => {
  it("replays the values the snapshot holds", () => {
    const { bar, post } = mount();
    bar.render(snap({ "ctl|header|photo": "on", "ctl|header|style": "ember" }));
    bar.replay();
    expect(post).toHaveBeenCalledWith({ cc: "control", part: "header", id: "photo", value: "on" }, "*");
    expect(post).toHaveBeenCalledWith({ cc: "control", part: "header", id: "style", value: "ember" }, "*");
  });

  it("drops a value the daemon cleared from a later snapshot of the same page", () => {
    const { bar, post } = mount();
    bar.render(snap({ "ctl|header|photo": "on", "ctl|header|style": "ember" }));
    bar.render(snap({ "ctl|header|style": "ember" }));
    post.mockClear();
    bar.replay();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({ cc: "control", part: "header", id: "style", value: "ember" }, "*");
  });

  it("keeps a value a later snapshot still holds, and picks up the ones it adds", () => {
    const { bar, post } = mount();
    bar.render(snap({ "ctl|header|photo": "on" }));
    bar.render(snap({ "ctl|header|photo": "on", "ctl|header|style": "ember" }));
    post.mockClear();
    bar.replay();
    expect(post).toHaveBeenCalledTimes(2);
  });
});
