import { describe, it, expect, beforeEach } from "vitest";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
};

const { loadRecents, pushRecent } = await import("../src/views/command-palette/recents.ts");

beforeEach(() => store.clear());

describe("palette recents", () => {
  it("starts empty", () => {
    expect(loadRecents()).toEqual([]);
  });

  it("keeps newest first and moves a repeat to the front without duplicating it", () => {
    pushRecent("a");
    pushRecent("b");
    pushRecent("a");
    expect(loadRecents()).toEqual(["a", "b"]);
  });

  it("keeps the 8 newest", () => {
    for (let i = 0; i < 12; i++) pushRecent(`c${i}`);
    expect(loadRecents()).toEqual(["c11", "c10", "c9", "c8", "c7", "c6", "c5", "c4"]);
  });

  it("survives a reload: the next load reads what the last push wrote", () => {
    pushRecent("kept");
    expect(JSON.parse(store.get("cc_palette_recents"))).toEqual(["kept"]);
  });

  it("reads corrupt storage as empty instead of throwing", () => {
    store.set("cc_palette_recents", "{not json");
    expect(loadRecents()).toEqual([]);
    store.set("cc_palette_recents", JSON.stringify({ a: 1 }));
    expect(loadRecents()).toEqual([]);
    store.set("cc_palette_recents", JSON.stringify(["ok", 3, null]));
    expect(loadRecents()).toEqual(["ok"]);
  });
});
