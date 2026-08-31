// @vitest-environment jsdom
//
// Icons are ~34KB each over /api/rpc and were re-fetched on every page load.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { characterAssetUrl } = vi.hoisted(() => ({ characterAssetUrl: vi.fn() }));
vi.mock("../src/shared/api.ts", () => ({
  api: { characterAssetUrl: (...a) => characterAssetUrl(...a) },
}));

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
      };
    },
    delete: async (name) => stores.delete(name),
  };
  return stores;
}

describe("character icon persistence", () => {
  beforeEach(() => {
    vi.resetModules();
    installFakeCaches();
    characterAssetUrl.mockReset().mockResolvedValue("data:image/png;base64,AAAA");
  });

  it("fetches once, then serves the persisted copy to a fresh page load", async () => {
    const first = await import("../src/shared/character-icon.ts");
    expect(await first.getCharacterIconUrl("dva")).toBe("data:image/png;base64,AAAA");
    expect(characterAssetUrl).toHaveBeenCalledTimes(1);

    // A reload drops the module-level memory cache but not the Cache API store.
    vi.resetModules();
    const second = await import("../src/shared/character-icon.ts");
    expect(await second.getCharacterIconUrl("dva")).toBe("data:image/png;base64,AAAA");
    expect(characterAssetUrl).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after the persisted icons are cleared", async () => {
    const mod = await import("../src/shared/character-icon.ts");
    await mod.getCharacterIconUrl("dva");
    const store = await import("../src/shared/character-icon-store.ts");
    await store.clearPersistedIcons();

    vi.resetModules();
    const fresh = await import("../src/shared/character-icon.ts");
    await fresh.getCharacterIconUrl("dva");
    expect(characterAssetUrl).toHaveBeenCalledTimes(2);
  });

  it("does not persist a 'no icon' result, so artwork added later is picked up", async () => {
    characterAssetUrl.mockResolvedValue(null);
    const mod = await import("../src/shared/character-icon.ts");
    expect(await mod.getCharacterIconUrl("ghost")).toBeNull();

    vi.resetModules();
    characterAssetUrl.mockResolvedValue("data:image/png;base64,BBBB");
    const later = await import("../src/shared/character-icon.ts");
    expect(await later.getCharacterIconUrl("ghost")).toBe("data:image/png;base64,BBBB");
  });

  it("falls back to the network when the Cache API is unavailable", async () => {
    delete globalThis.caches;
    const mod = await import("../src/shared/character-icon.ts");
    expect(await mod.getCharacterIconUrl("dva")).toBe("data:image/png;base64,AAAA");
  });
});
