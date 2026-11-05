// @vitest-environment jsdom
// The panel of a main chat covers its subs: the shared mockup and each sub's
// dedicated pages are listed, another chat's are not, and a control change is
// posted into the staged frame instead of re-staging it.
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls = [];
const NOW = "2026-11-05T00:00:00.000Z";
const metas = [
  { id: "shared-1", slug: "portfolio", title: "Portfolio", source: "chat", session_id: "main", version: 2, created_at: NOW, shared: true, versions: [] },
  { id: "ded-1", slug: "footer-spacing", title: "Footer spacing", source: "chat_card", session_id: "sub-footer", version: 1, created_at: NOW, shared: false, versions: [] },
  { id: "ded-2", slug: "hero-variants", title: "Hero variants", source: "chat_card", session_id: "sub-hero", version: 1, created_at: NOW, shared: false, versions: [] },
  { id: "else-1", slug: "elsewhere", title: "Elsewhere", source: "chat", session_id: "other", version: 1, created_at: NOW, shared: false, versions: [] },
];
const control = (id, kind, extra = {}) => ({ id, label: id, kind, options: [], default: kind === "switch" ? "off" : "", ...extra });
const sharedSnap = {
  ...metas[0],
  html: "<p>page</p>",
  shared: {
    owner_session_id: "main",
    shell: "",
    parts: [
      { id: "header", owner_session_id: "sub-hero", owner_name: "Hero", html: "", css: "", controls: [control("style", "select", { options: ["aurora", "ember"], default: "aurora" }), control("photo", "switch")] },
    ],
  },
};
vi.mock("../src/shared/ipc", () => ({
  invoke: (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "list_previews") return Promise.resolve(metas);
    if (cmd === "get_preview") return Promise.resolve(args.id === "shared-1" ? sharedSnap : { ...metas.find((m) => m.id === args.id), html: "<p>x</p>" });
    if (cmd === "render_preview_doc") return Promise.resolve("about:blank");
    if (cmd === "list_slash_commands") return Promise.resolve([]);
    return Promise.resolve(undefined);
  },
}));
vi.mock("../src/shared/transport", () => ({
  getTransport: () => ({ listen: () => Promise.resolve(() => {}) }),
  isRemote: () => false,
}));

const { mountPreviewTab } = await import("../src/views/sessions/preview-panel.ts");
const { state } = await import("../src/views/sessions/state.ts");

const inst = (id, extra = {}) => ({ session_id: id, name: id, ...extra });

function mount() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const tab = mountPreviewTab(root, { isOpen: () => true, isVisible: () => true, requestOpen() {}, markOpenFor() {} });
  return { root, tab };
}

beforeEach(() => {
  calls.length = 0;
  document.body.innerHTML = "";
  state.sessions = [
    inst("main"),
    inst("sub-hero", { subchat_of: "main", name: "Hero" }),
    inst("sub-footer", { subchat_of: "main", name: "Footer" }),
    inst("sub-skills", { subchat_of: "main", name: "Skills" }),
    inst("other"),
  ];
});

describe("preview panel scope for a main chat", () => {
  it("lists the main chat's shared mockup and its subs' dedicated pages, not another chat's", async () => {
    const { root, tab } = mount();
    tab.setSessionScope("main");
    await vi.waitFor(() => expect(root.querySelector(".pv-name").textContent).toBe("portfolio"));
    root.querySelector('[data-act="previews"]').click();
    const rows = [...document.querySelectorAll(".pv-history-popover .pv-snap-title")].map((r) => r.textContent.trim());
    expect(rows).toEqual(["Portfolio", "Footer spacing", "Hero variants"]);
    const labels = [...document.querySelectorAll(".pv-history-popover .pv-hist-lbl")].map((l) => l.textContent);
    expect(labels).toEqual(["Shared", "Dedicated"]);
    expect(calls.find((c) => c.cmd === "list_previews").args).toEqual({ sessionId: "main" });
    tab.destroy();
  });

  it("an ordinary chat still lists only its own previews", async () => {
    const { root, tab } = mount();
    tab.setSessionScope("other");
    await vi.waitFor(() => expect(root.querySelector(".pv-name").textContent).toBe("elsewhere"));
    expect(root.querySelector(".pv-shared").hidden).toBe(true);
    tab.destroy();
  });

  it("reading a sub in place covers the same family and asks the daemon for the main chat's list", async () => {
    const { root, tab } = mount();
    tab.setSessionScope("sub-hero");
    await vi.waitFor(() => expect(root.querySelector(".pv-name").textContent).toBe("portfolio"));
    expect(calls.find((c) => c.cmd === "list_previews").args).toEqual({ sessionId: "main" });
    tab.destroy();
  });
});

describe("shared mockup controls", () => {
  async function openShared() {
    const m = mount();
    m.tab.setSessionScope("main");
    await vi.waitFor(() => expect(m.root.querySelector(".pv-shared").hidden).toBe(false));
    await vi.waitFor(() => expect(m.root.querySelector(".pv-iframe")).toBeTruthy());
    const frame = m.root.querySelector(".pv-iframe");
    const post = vi.fn();
    Object.defineProperty(frame, "contentWindow", { value: { postMessage: post }, configurable: true });
    return { ...m, post, frame };
  }

  it("shows a chip per sub: the one with controls clickable, the others dashed", async () => {
    const { root, tab } = await openShared();
    const chips = [...root.querySelectorAll(".pvs-chip")];
    expect(chips.map((c) => [c.dataset.owner, c.classList.contains("idle"), c.tagName])).toEqual([
      ["sub-hero", false, "BUTTON"],
      ["sub-footer", true, "SPAN"],
      ["sub-skills", true, "SPAN"],
    ]);
    tab.destroy();
  });

  it("a choice is a native dropdown and a yes/no is a switch, never chips", async () => {
    const { root, tab } = await openShared();
    root.querySelector('.pvs-chip[data-owner="sub-hero"]').click();
    const pop = root.querySelector(".pvs-pop");
    expect(pop.querySelectorAll("select").length).toBe(1);
    expect(pop.querySelector("label.pvs-field > span").textContent).toBe("style");
    expect(pop.querySelectorAll('[role="switch"]').length).toBe(1);
    expect(pop.querySelector(".pvs-title, .pv-hist-lbl")).toBeNull();
    tab.destroy();
  });

  it("changing a control posts it into the staged frame and does not stage a new one", async () => {
    const { root, tab, post, frame } = await openShared();
    const renders = () => calls.filter((c) => c.cmd === "render_preview_doc").length;
    const before = renders();
    root.querySelector('.pvs-chip[data-owner="sub-hero"]').click();
    const sel = root.querySelector("select");
    sel.value = "ember";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    expect(post).toHaveBeenLastCalledWith({ cc: "control", part: "header", id: "style", value: "ember" }, "*");
    root.querySelector('[role="switch"]').click();
    expect(post).toHaveBeenLastCalledWith({ cc: "control", part: "header", id: "photo", value: "on" }, "*");
    expect(root.querySelector('[role="switch"]').getAttribute("aria-checked")).toBe("true");
    expect(renders()).toBe(before);
    expect(root.querySelector(".pv-iframe")).toBe(frame);
    tab.destroy();
  });

  it("a freshly staged frame gets the values Joe already set", async () => {
    const { root, tab, post, frame } = await openShared();
    root.querySelector('.pvs-chip[data-owner="sub-hero"]').click();
    root.querySelector('[role="switch"]').click();
    post.mockClear();
    frame.dispatchEvent(new Event("load"));
    expect(post).toHaveBeenCalledWith({ cc: "control", part: "header", id: "photo", value: "on" }, "*");
    tab.destroy();
  });

  it("a dedicated page carries the Only tag and a back arrow to the shared page, and hides the row", async () => {
    const { root, tab } = await openShared();
    root.querySelector('[data-act="previews"]').click();
    [...document.querySelectorAll(".pv-history-popover .pv-snap")].find((r) => r.dataset.id === "ded-1").click();
    await vi.waitFor(() => expect(root.querySelector(".pv-name").textContent).toBe("footer-spacing"));
    expect(root.querySelector(".pv-kind").textContent).toContain("Only Footer");
    expect(root.querySelector(".pv-shared").hidden).toBe(true);
    const back = root.querySelector(".pv-back");
    expect(back.hidden).toBe(false);
    back.click();
    await vi.waitFor(() => expect(root.querySelector(".pv-name").textContent).toBe("portfolio"));
    expect(root.querySelector(".pv-back").hidden).toBe(true);
    tab.destroy();
  });

  it("a sub's controls end with a link to its own dedicated pages only", async () => {
    const { root, tab } = await openShared();
    root.querySelector('.pvs-chip[data-owner="sub-hero"]').click();
    const links = [...root.querySelectorAll(".pvs-link")];
    expect(links.map((l) => l.dataset.open)).toEqual(["ded-2"]);
    links[0].click();
    await vi.waitFor(() => expect(root.querySelector(".pv-name").textContent).toBe("hero-variants"));
    tab.destroy();
  });
});
