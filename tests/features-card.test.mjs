// @vitest-environment jsdom
// asserts: src/views/sessions/chat-dashboard/features-card.ts

// The merged Plan card's DOM owner: the chat Joe is writing to stays shown while another chat of the
// feature starts asking, a picture whose bytes cannot be read is asked for once, and a redraw tells
// the dashboard so the preview frames in it get their page.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/views/sessions/chat-dashboard/sub-composer.ts", () => ({
  mountSubComposer: (root, id) => {
    root.dataset.composerFor = id;
    return { destroy: () => { root.dataset.destroyed = "1"; }, refreshOfflineState: () => {}, isDraftEmpty: () => globalThis.__draftEmpty !== false };
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
  globalThis.__draftEmpty = true;
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
    globalThis.__draftEmpty = false;
    // A second chat now needs Joe: the line shows both icons, the writing chat keeps its box.
    c.update(host, feature(item("a", "pc-9 build", "working", 1), item("b", "pc-9 review", "asking", 2)));
    expect(host.querySelector(".pf-body").dataset.chat).toBe("a");
    expect(host.querySelector(".pf-slot [data-composer-for]")).toBe(root);
    expect(root.dataset.destroyed).toBeUndefined();
  });

  it("lets a chat that needs Joe take over while the reply box is untouched", () => {
    const host = mountHost();
    const c = card();
    c.update(host, feature(item("a", "pc-9 build", "working", 1)));
    c.act("pf-feat", lineEl());
    c.update(host, feature(item("a", "pc-9 build", "working", 1), item("b", "pc-9 review", "asking", 2)));
    expect(host.querySelector(".pf-body").dataset.chat).toBe("b");
  });

  it("holds on the chat whose box has focus even with no text yet", () => {
    const host = mountHost();
    const c = card();
    c.update(host, feature(item("a", "pc-9 build", "working", 1)));
    c.act("pf-feat", lineEl());
    const root = host.querySelector(".pf-slot [data-composer-for]");
    const field = document.createElement("textarea");
    root.appendChild(field);
    field.focus();
    c.update(host, feature(item("a", "pc-9 build", "working", 1), item("b", "pc-9 review", "asking", 2)));
    expect(host.querySelector(".pf-body").dataset.chat).toBe("a");
  });

  it("never holds on a chat that has finished, even with text in its box", () => {
    const host = mountHost();
    const c = card();
    c.update(host, feature(item("a", "pc-9 build", "working", 1)));
    c.act("pf-feat", lineEl());
    globalThis.__draftEmpty = false;
    c.update(host, feature(item("a", "pc-9 build", "finished", 1), item("b", "pc-9 review", "asking", 2)));
    expect(host.querySelector(".pf-body").dataset.chat).toBe("b");
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

describe("a +N on a line with many chats", () => {
  // Eight finished chats then one working: the finished fold into the +N at the front.
  const crowd = () => feature(
    ...Array.from({ length: 8 }, (_, i) => item(`d${i}`, `pc-9 done ${i}`, "finished", i + 1)),
    item("w", "pc-9 work", "working", 20),
  );

  it("opens its chats in a list, a pick opens that chat in the line, and the list follows a redraw", () => {
    const host = mountHost();
    const c = card();
    c.update(host, crowd());
    const fold = host.querySelector(".pf-fold[data-which='done']");
    expect(fold.textContent).toBe("+8");
    c.act("pf-fold", fold);
    expect(document.querySelectorAll(".pf-pop .pf-pop-row")).toHaveLength(8);
    expect(host.querySelector(".pf-fold").getAttribute("aria-expanded")).toBe("true");
    // The working chat's step moves on: the lines are rewritten and the list moves to the new +N.
    const next = crowd();
    next.rows[0].chats.find((x) => x.id === "w").item.progress = "step 3 of 4";
    c.update(host, next);
    expect(document.querySelectorAll(".pf-pop")).toHaveLength(1);
    expect(host.querySelector(".pf-fold").getAttribute("aria-expanded")).toBe("true");
    document.querySelector(".pf-pop-row[data-chat='d3']").click();
    expect(document.querySelectorAll(".pf-pop")).toHaveLength(0);
    expect(host.querySelector(".pf-body").dataset.chat).toBe("d3");
    expect(host.querySelector(".pf-fold").classList.contains("is-sel")).toBe(true);
  });

  it("shuts the list on a second click and when the card lets go of its lines", () => {
    const host = mountHost();
    const c = card();
    c.update(host, crowd());
    c.act("pf-fold", host.querySelector(".pf-fold"));
    c.act("pf-fold", host.querySelector(".pf-fold"));
    expect(document.querySelectorAll(".pf-pop")).toHaveLength(0);
    c.act("pf-fold", host.querySelector(".pf-fold"));
    expect(document.querySelectorAll(".pf-pop")).toHaveLength(1);
    c.detach();
    expect(document.querySelectorAll(".pf-pop")).toHaveLength(0);
  });
});
