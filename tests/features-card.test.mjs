// @vitest-environment jsdom
// asserts: src/views/sessions/chat-dashboard/features-card.ts

// The merged Plan card's DOM owner: the chat Joe is writing to stays shown while another chat of the
// feature starts asking, a picture whose bytes cannot be read is asked for once, and a redraw tells
// the dashboard so the preview frames in it get their page.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/views/sessions/chat-dashboard/sub-composer.ts", () => ({
  mountSubComposer: (root, id) => {
    root.dataset.composerFor = id;
    return { destroy: () => { root.dataset.destroyed = "1"; }, refreshOfflineState: () => {} };
  },
}));

const { resetTransportForTests } = await import("../src/shared/transport.ts");
const { FeaturesCard } = await import("../src/views/sessions/chat-dashboard/features-card.ts");
const { buildFeatures } = await import("../src/shared/chat/dashboard/features-model.ts");

const at = (min) => new Date(Date.UTC(2026, 10, 23, 10, min)).toISOString();
const item = (id, name, kind, startMin) => ({
  id, name, kind, closing: false, model: "claude-sonnet-5-5", effort: "high", progress: kind,
  startedAt: at(startMin), finishedAt: null, ring: null, hover: null,
});
const feature = (...items) => buildFeatures(items.map((it) => ({ item: it, todoId: "pc-9", title: "Job" })));

if (!globalThis.CSS) globalThis.CSS = { escape: (v) => String(v).replace(/[^a-zA-Z0-9_-]/g, "\$&") };

let calls;
let images;
beforeEach(() => {
  document.body.innerHTML = "";
  calls = [];
  images = [];
  globalThis.window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === "list_session_images") return { images };
        if (cmd === "dashboard_gallery_image") throw new Error("gone");
        return null;
      },
    },
    event: { listen: async () => () => {} },
  };
  resetTransportForTests();
});

const card = (over = {}) => new FeaturesCard({ cwd: () => null, instance: () => undefined, previews: () => [], task: () => "", ...over });
const mountHost = () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
};
const lineEl = () => {
  const el = document.createElement("div");
  el.dataset.feat = "todo:pc-9";
  return el;
};
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("the opened feature's chat", () => {
  it("stays shown with its reply box when another chat of the feature starts asking", () => {
    const host = mountHost();
    const c = card();
    c.update(host, feature(item("a", "pc-9 build", "working", 1)));
    c.act("pf-feat", lineEl());
    expect(host.querySelector(".pf-body").dataset.chat).toBe("a");
    const root = host.querySelector(".pf-slot [data-composer-for]");
    expect(root.dataset.composerFor).toBe("a");
    // A second chat now needs Joe: the line shows both icons, the writing chat keeps its box.
    c.update(host, feature(item("a", "pc-9 build", "working", 1), item("b", "pc-9 review", "asking", 2)));
    expect(host.querySelector(".pf-body").dataset.chat).toBe("a");
    expect(host.querySelector(".pf-slot [data-composer-for]")).toBe(root);
    expect(root.dataset.destroyed).toBeUndefined();
  });
});

describe("a picture that cannot be read", () => {
  it("is asked for once, not in a loop", async () => {
    images = [{ id: "i1", at_ms: 5 }];
    const host = mountHost();
    const c = card();
    c.update(host, feature(item("a", "pc-9 build", "working", 1)));
    c.act("pf-feat", lineEl());
    await tick(80);
    expect(calls.filter(([cmd]) => cmd === "dashboard_gallery_image")).toHaveLength(1);
  });
});

describe("a redraw of the lines", () => {
  it("tells the dashboard, so preview frames in them are mounted", () => {
    const drawn = vi.fn();
    const host = mountHost();
    const c = card({ drawn });
    c.update(host, feature(item("a", "pc-9 build", "working", 1)));
    expect(drawn).toHaveBeenCalledTimes(1);
    // The same state draws the same markup: nothing rewritten, nothing to mount.
    c.update(host, feature(item("a", "pc-9 build", "working", 1)));
    expect(drawn).toHaveBeenCalledTimes(1);
  });
});
