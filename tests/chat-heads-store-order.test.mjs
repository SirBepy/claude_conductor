// asserts: src/views/sessions/chat-heads-drag.ts
// A head drop stores Joe's order. The desktop saves settings.json through the stale-safe
// writer; the phone is refused `save_settings`, so it sends the finished order through
// `set_chat_heads_order` (the daemon validates and persists that one key).

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const updateSettings = vi.fn();
const setSettings = vi.fn();
let remote = false;

vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invoke(...a) }));
vi.mock("../src/shared/settings-update.ts", () => ({ updateSettings: (...a) => updateSettings(...a) }));
vi.mock("../src/shared/state.ts", () => ({ setSettings: (...a) => setSettings(...a) }));
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => remote }));
vi.mock("../src/views/sessions/sidebar-anim.ts", () => ({ holdFlipOnce: () => {} }));
vi.mock("../src/views/sessions/sidebar-hover-card.ts", () => ({ hideHoverCard: () => {} }));

const { storeOrder } = await import("../src/views/sessions/chat-heads-drag.ts");

beforeEach(() => {
  invoke.mockReset();
  updateSettings.mockReset();
  setSettings.mockReset();
  remote = false;
});

describe("storeOrder", () => {
  it("on the desktop saves the order inside the stale-safe settings writer", async () => {
    updateSettings.mockImplementation(async (mutate) => mutate({ chatHeadsOrder: ["x", "a", "b"], theme: "dark" }));
    await storeOrder(["a", "b", "c"], "c", 0);
    expect(updateSettings).toHaveBeenCalledTimes(1);
    const saved = await updateSettings.mock.results[0].value;
    expect(saved.chatHeadsOrder).toEqual(["c", "a", "b", "x"]);
    expect(saved.theme).toBe("dark");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("on the phone sends the finished order through set_chat_heads_order, never save_settings", async () => {
    remote = true;
    invoke.mockImplementation(async (cmd) => (cmd === "get_settings" ? { chatHeadsOrder: ["x", "a", "b"], theme: "dark" } : { ok: true }));
    await storeOrder(["a", "b", "c"], "c", 0);
    expect(invoke).toHaveBeenCalledWith("set_chat_heads_order", { order: ["c", "a", "b", "x"] });
    expect(invoke.mock.calls.map((c) => c[0])).not.toContain("save_settings");
    expect(updateSettings).not.toHaveBeenCalled();
    expect(setSettings).toHaveBeenCalledWith({ chatHeadsOrder: ["c", "a", "b", "x"], theme: "dark" });
  });

  it("on the phone lets a refused write reach the caller so the head snaps back", async () => {
    remote = true;
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "get_settings") return {};
      throw new Error("offline");
    });
    await expect(storeOrder(["a", "b"], "b", 0)).rejects.toThrow("offline");
    expect(setSettings).not.toHaveBeenCalled();
  });
});
