// @vitest-environment jsdom
//
// The preview panel's two pickers: the name opens this chat's previews, the
// version beside it opens the versions of the one in view. A push only moves
// the view while it shows the latest page of the preview being pushed; any
// other push dots the picker that reaches it (Joe, 2026-10-30).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const SID = "chat-1";
const at = (n) => `2026-10-30T10:0${n}:00.000Z`;

let previews;
let calls;
let pushHandler;

const meta = (id, version, versions = [], extra = {}) => ({
  id, slug: id, title: id, source: "chat", session_id: SID, version, created_at: at(version), published: null, versions, ...extra,
});

vi.mock("../src/shared/ipc", () => ({
  invoke: (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "list_previews") return Promise.resolve(previews);
    if (cmd === "get_preview") {
      const m = previews.find((p) => p.id === args.id);
      const version = args.version ?? m.version;
      return Promise.resolve({ ...m, version, html: `<p>${m.id} v${version}</p>`, versions: undefined });
    }
    if (cmd === "render_preview_doc") return Promise.resolve("about:blank");
    if (cmd === "list_slash_commands") return Promise.resolve([]);
    return Promise.resolve(undefined);
  },
}));
vi.mock("../src/shared/transport", () => ({
  getTransport: () => ({
    listen: (event, cb) => {
      if (event === "preview") pushHandler = cb;
      return Promise.resolve(() => {});
    },
  }),
  isRemote: () => false,
}));

const { mountPreviewTab } = await import("../src/views/sessions/preview-panel.ts");
const { closePvHistory } = await import("../src/views/sessions/preview-panel-history.ts");

let root;
let tab;

async function mount(list) {
  previews = list;
  root = document.createElement("div");
  document.body.appendChild(root);
  tab = mountPreviewTab(root, { isOpen: () => true, isVisible: () => true, requestOpen() {}, markOpenFor() {} });
  tab.setSessionScope(SID);
  await vi.waitFor(() => expect(root.querySelector(".pv-name").textContent).not.toBe("No previews yet"));
  await vi.waitFor(() => expect(pushHandler).toBeTypeOf("function"));
}

const nameBtn = () => root.querySelector(".pv-pick-name");
const verBtn = () => root.querySelector(".pv-pick-ver");
const fetches = () => calls.filter((c) => c.cmd === "get_preview");
const pushed = (m) => pushHandler({ snapshot: m });

async function pickVersion(label) {
  verBtn().click();
  const rows = [...document.querySelectorAll(".pv-history-popover .pv-snap")];
  rows.find((r) => r.querySelector(".pv-snap-title").textContent === label).click();
}

beforeEach(() => {
  calls = [];
  pushHandler = undefined;
});

afterEach(() => {
  closePvHistory();
  tab?.destroy();
  document.body.innerHTML = "";
});

describe("preview pickers", () => {
  it("offers the version picker only when the preview kept earlier versions", async () => {
    await mount([meta("one", 1)]);
    expect(verBtn().hidden).toBe(true);
    tab.destroy();
    document.body.innerHTML = "";

    await mount([meta("one", 3, [{ version: 2, created_at: at(2) }, { version: 1, created_at: at(1) }])]);
    expect(verBtn().hidden).toBe(false);
    expect(root.querySelector(".pv-ver").textContent).toBe("Latest");
  });

  it("makes a lone preview's name a plain label and a second preview a dropdown", async () => {
    await mount([meta("one", 1)]);
    expect(nameBtn().hasAttribute("data-single")).toBe(true);
    tab.destroy();
    document.body.innerHTML = "";

    await mount([meta("two", 2), meta("one", 1)]);
    expect(nameBtn().hasAttribute("data-single")).toBe(false);
  });

  it("lists Latest then each kept version, and opens the one picked", async () => {
    await mount([meta("one", 3, [{ version: 2, created_at: at(2) }, { version: 1, created_at: at(1) }])]);
    verBtn().click();
    const titles = [...document.querySelectorAll(".pv-history-popover .pv-snap-title")].map((e) => e.textContent);
    expect(titles).toEqual(["Latest", "v2", "v1"]);
    closePvHistory();

    await pickVersion("v2");
    await vi.waitFor(() => expect(root.querySelector(".pv-ver").textContent).toBe("v2"));
    expect(fetches().at(-1).args).toEqual({ id: "one", sessionId: SID, version: 2 });

    await pickVersion("Latest");
    await vi.waitFor(() => expect(root.querySelector(".pv-ver").textContent).toBe("Latest"));
    // The latest page was cached from the first load, so Latest asks nothing.
    expect(fetches().filter((c) => c.args.version === undefined)).toHaveLength(1);
  });

  it("opens another preview from the name picker at its latest page", async () => {
    await mount([meta("two", 2), meta("one", 1)]);
    nameBtn().click();
    [...document.querySelectorAll(".pv-history-popover .pv-snap")].find((r) => r.dataset.id === "one").click();
    await vi.waitFor(() => expect(root.querySelector(".pv-name").textContent).toBe("one"));
  });
});

describe("a push while the panel is open", () => {
  it("follows the push when the latest page of that preview is in view", async () => {
    await mount([meta("one", 1)]);
    const before = fetches().length;
    previews = [meta("one", 2, [{ version: 1, created_at: at(1) }])];
    pushed(previews[0]);
    await vi.waitFor(() => expect(fetches().length).toBe(before + 1));
    expect(fetches().at(-1).args).toEqual({ id: "one", sessionId: SID });
    expect(verBtn().hasAttribute("data-new")).toBe(false);
    expect(verBtn().hidden).toBe(false);
  });

  it("stays on an older version, dots the version picker, and clears the dot on Latest", async () => {
    await mount([meta("one", 3, [{ version: 2, created_at: at(2) }, { version: 1, created_at: at(1) }])]);
    await pickVersion("v1");
    await vi.waitFor(() => expect(root.querySelector(".pv-ver").textContent).toBe("v1"));
    const before = fetches().length;

    previews = [meta("one", 4, [{ version: 3, created_at: at(3) }, { version: 2, created_at: at(2) }, { version: 1, created_at: at(1) }])];
    pushed(previews[0]);
    expect(fetches().length).toBe(before);
    expect(root.querySelector(".pv-ver").textContent).toBe("v1");
    expect(verBtn().hasAttribute("data-new")).toBe(true);

    await pickVersion("Latest");
    await vi.waitFor(() => expect(verBtn().hasAttribute("data-new")).toBe(false));
    expect(fetches().at(-1).args).toEqual({ id: "one", sessionId: SID });
  });

  it("stays on the current preview when a different one is pushed, and dots the name picker", async () => {
    await mount([meta("one", 1)]);
    const before = fetches().length;

    previews = [meta("two", 1), meta("one", 1)];
    pushed(previews[0]);
    expect(fetches().length).toBe(before);
    expect(root.querySelector(".pv-name").textContent).toBe("one");
    expect(nameBtn().hasAttribute("data-new")).toBe(true);

    nameBtn().click();
    [...document.querySelectorAll(".pv-history-popover .pv-snap")].find((r) => r.dataset.id === "two").click();
    await vi.waitFor(() => expect(root.querySelector(".pv-name").textContent).toBe("two"));
    expect(nameBtn().hasAttribute("data-new")).toBe(false);
  });

  it("treats a publish re-broadcast of the same version as no new page", async () => {
    await mount([meta("one", 3, [{ version: 2, created_at: at(2) }])]);
    await pickVersion("v2");
    await vi.waitFor(() => expect(root.querySelector(".pv-ver").textContent).toBe("v2"));
    const before = fetches().length;

    pushed({ ...previews[0], published: { url: "https://claude.ai/artifact/AB", version: 3, account: "Joe", published_at: "now" } });
    expect(fetches().length).toBe(before);
    expect(verBtn().hasAttribute("data-new")).toBe(false);
  });

  it("keeps an archived version in view across a refetch while it is still kept", async () => {
    await mount([meta("one", 3, [{ version: 2, created_at: at(2) }])]);
    await pickVersion("v2");
    await vi.waitFor(() => expect(root.querySelector(".pv-ver").textContent).toBe("v2"));

    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(calls.filter((c) => c.cmd === "list_previews").length).toBeGreaterThan(1));
    expect(root.querySelector(".pv-ver").textContent).toBe("v2");

    // The version aged out of the kept set: back to the latest page.
    previews = [meta("one", 9)];
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(verBtn().hidden).toBe(true));
    expect(root.querySelector(".pv-ver").textContent).toBe("Latest");
  });
});
