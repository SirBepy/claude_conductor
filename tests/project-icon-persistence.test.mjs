// @vitest-environment jsdom
//
// A project's icon came over /api/rpc as a base64 body on every page load. The phone now keeps
// it between loads and asks the daemon "still this one?" with the hash it holds.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { getProjectIcon, getProjectTech, remote } = vi.hoisted(() => ({
  getProjectIcon: vi.fn(),
  getProjectTech: vi.fn(),
  remote: { on: true },
}));
vi.mock("../src/shared/api.ts", () => ({
  api: {
    getProjectIcon: (...a) => getProjectIcon(...a),
    getProjectTech: (...a) => getProjectTech(...a),
  },
}));
vi.mock("../src/shared/transport.ts", async (orig) => ({ ...(await orig()), isRemote: () => remote.on }));

/** Minimal in-memory CacheStorage, enough for open/match/put/delete. */
function installFakeCaches() {
  const stores = new Map();
  globalThis.caches = {
    open: async (name) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        match: async (key) => {
          const body = store.get(key);
          return body === undefined ? undefined : { text: async () => body };
        },
        put: async (key, res) => {
          store.set(key, await res.text());
        },
        delete: async (key) => store.delete(key),
      };
    },
    delete: async (name) => stores.delete(name),
  };
}

const ICON_A = { mime: "image/png", base64: "AAAA", hash: "hash-a" };
const URL_A = "data:image/png;base64,AAAA";
const ICON_B = { mime: "image/png", base64: "BBBB", hash: "hash-b" };
const URL_B = "data:image/png;base64,BBBB";

/** A page load: fresh module state (the memory caches), same Cache API store. */
async function freshPage() {
  vi.resetModules();
  document.body.innerHTML = `<span class="proj-face" data-proj-face="C:/proj"><i class="ph ph-folder"></i></span>`;
  const mod = await import("../src/shared/projects.ts");
  await mod.hydrateProjectTechIcons(document);
  // The hash check runs behind the paint: let it settle.
  await new Promise((r) => setTimeout(r, 0));
  return document.querySelector(".proj-face");
}

describe("project icon persistence on the phone", () => {
  beforeEach(() => {
    remote.on = true;
    installFakeCaches();
    getProjectIcon.mockReset().mockResolvedValue(ICON_A);
    getProjectTech.mockReset().mockResolvedValue(null);
  });

  it("fetches the body once, then a reloaded page paints the kept copy and only sends the hash", async () => {
    const first = await freshPage();
    expect(first.querySelector("img").getAttribute("src")).toBe(URL_A);
    expect(getProjectIcon).toHaveBeenCalledTimes(1);
    expect(getProjectIcon.mock.calls[0][2]).toBeUndefined();

    getProjectIcon.mockReset().mockResolvedValue({ unchanged: true, hash: "hash-a" });
    const second = await freshPage();
    expect(second.querySelector("img").getAttribute("src")).toBe(URL_A);
    // One request, carrying the held hash and answered without a body.
    expect(getProjectIcon).toHaveBeenCalledTimes(1);
    expect(getProjectIcon.mock.calls[0][2]).toBe("hash-a");
  });

  it("swaps in a changed icon and keeps the new one for the next load", async () => {
    await freshPage();
    getProjectIcon.mockReset().mockResolvedValue(ICON_B);
    const second = await freshPage();
    expect(second.querySelector("img").getAttribute("src")).toBe(URL_B);

    getProjectIcon.mockReset().mockResolvedValue({ unchanged: true, hash: "hash-b" });
    const third = await freshPage();
    expect(third.querySelector("img").getAttribute("src")).toBe(URL_B);
    expect(getProjectIcon.mock.calls[0][2]).toBe("hash-b");
  });

  it("drops a kept icon when the project no longer has one", async () => {
    await freshPage();
    getProjectIcon.mockReset().mockResolvedValue(null);
    const second = await freshPage();
    expect(second.querySelector("img")).toBeNull();

    // The next load starts cold again: no hash is sent.
    getProjectIcon.mockReset().mockResolvedValue(null);
    await freshPage();
    expect(getProjectIcon.mock.calls[0][2]).toBeUndefined();
  });

  it("keeps the kept copy on screen when the hash check fails", async () => {
    await freshPage();
    getProjectIcon.mockReset().mockRejectedValue(new Error("tunnel down"));
    const second = await freshPage();
    expect(second.querySelector("img").getAttribute("src")).toBe(URL_A);
  });

  it("does not keep anything on the desktop, where the daemon is local", async () => {
    remote.on = false;
    await freshPage();
    getProjectIcon.mockClear();
    const second = await freshPage();
    expect(second.querySelector("img").getAttribute("src")).toBe(URL_A);
    expect(getProjectIcon).toHaveBeenCalledTimes(1);
    expect(getProjectIcon.mock.calls[0][2]).toBeUndefined();
  });

  it("asks about each project once per page load however often its face is drawn", async () => {
    await freshPage();
    getProjectIcon.mockReset().mockResolvedValue({ unchanged: true, hash: "hash-a" });
    vi.resetModules();
    document.body.innerHTML = `<span class="proj-face" data-proj-face="C:/proj"></span><span class="proj-face" data-proj-face="C:/proj"></span>`;
    const mod = await import("../src/shared/projects.ts");
    await mod.hydrateProjectTechIcons(document);
    document.body.insertAdjacentHTML("beforeend", `<span class="proj-face" data-proj-face="C:/proj"></span>`);
    await mod.hydrateProjectTechIcons(document);
    await new Promise((r) => setTimeout(r, 0));
    expect(getProjectIcon).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll(".proj-face img")).toHaveLength(3);
  });
});
