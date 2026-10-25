// Machine profile: a chosen icon wins over the automatic one, a
// machines-changed event refreshes the icon map, and set_machine_profile
// reaches the daemon with the right args on desktop and on the phone.

import { describe, it, expect, beforeEach, vi } from "vitest";

const icons = await import("../src/views/sessions/machine-icons.ts");
const { assignMachineIcons, setMachines, machineIcon, initMachineProfileSync, resetMachineIconsForTests } = icons;
const { resetTransportForTests } = await import("../src/shared/transport.ts");
const { api } = await import("../src/shared/api.ts");
const { HttpTransport } = await import("../src/shared/http-transport.ts");

const PC = { machine_id: "a-pc", os: "windows" };
const MAC = { machine_id: "b-mac", os: "macos" };
const STUDIO = { machine_id: "c-studio", os: "macos" };

describe("assignMachineIcons with a chosen icon", () => {
  it("the chosen icon wins over the OS logo", () => {
    const m = assignMachineIcons([{ ...PC, icon: "ph-rocket-launch" }, MAC]);
    expect(m.get("a-pc")).toBe("ph-rocket-launch");
    expect(m.get("b-mac")).toBe("ph-apple-logo");
  });

  it("automatic logic skips a chosen icon", () => {
    // MAC would keep the Apple logo; STUDIO clashes and must not land on the
    // glyph the PC chose, wherever the hash would start.
    const taken = assignMachineIcons([MAC, STUDIO]).get("c-studio");
    const m = assignMachineIcons([{ ...PC, icon: taken }, MAC, STUDIO]);
    expect(m.get("a-pc")).toBe(taken);
    expect(m.get("c-studio")).not.toBe(taken);
  });

  it("a chosen OS logo is not handed to an automatic machine", () => {
    const m = assignMachineIcons([{ ...PC, icon: "ph-apple-logo" }, MAC]);
    expect(m.get("a-pc")).toBe("ph-apple-logo");
    expect(m.get("b-mac")).not.toBe("ph-apple-logo");
  });

  it("two machines may choose the same icon", () => {
    const m = assignMachineIcons([{ ...PC, icon: "ph-leaf" }, { ...MAC, icon: "ph-leaf" }]);
    expect(m.get("a-pc")).toBe("ph-leaf");
    expect(m.get("b-mac")).toBe("ph-leaf");
  });

  it("a missing or null icon stays automatic", () => {
    const m = assignMachineIcons([{ ...PC, icon: null }, MAC]);
    expect(m.get("a-pc")).toBe("ph-windows-logo");
    expect(m.get("b-mac")).toBe("ph-apple-logo");
  });
});

describe("machines-changed listener", () => {
  let handlers;
  let invoke;

  beforeEach(() => {
    resetMachineIconsForTests();
    resetTransportForTests();
    handlers = new Map();
    invoke = vi.fn();
    globalThis.window = {
      __TAURI__: {
        core: { invoke },
        event: {
          listen: async (name, cb) => { handlers.set(name, cb); return () => handlers.delete(name); },
        },
      },
    };
  });

  it("re-fetches list_machines and updates the icon map", async () => {
    setMachines({ self: { ...PC, label: "PC", icon: null }, peers: [] });
    expect(machineIcon("a-pc")).toBe("ph-windows-logo");

    invoke.mockResolvedValue({ self: { ...PC, label: "PC", icon: "ph-planet" }, peers: [] });
    const onChange = vi.fn();
    initMachineProfileSync(onChange);
    await vi.waitFor(() => expect(handlers.has("machines-changed")).toBe(true));
    handlers.get("machines-changed")({ payload: null });

    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith("list_machines", undefined);
    expect(machineIcon("a-pc")).toBe("ph-planet");
  });
});

describe("set_machine_profile routing", () => {
  beforeEach(() => {
    resetTransportForTests();
  });

  it("desktop sends camelCase args, and automatic as clearIcon since Tauri reads null as absent", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    globalThis.window = { __TAURI__: { core: { invoke } } };
    await api.setMachineProfile("m1", { label: "Studio", icon: null });
    expect(invoke).toHaveBeenCalledWith("set_machine_profile", { machineId: "m1", label: "Studio", clearIcon: true });
    await api.setMachineProfile(null, { icon: "ph-leaf" });
    expect(invoke).toHaveBeenLastCalledWith("set_machine_profile", { machineId: null, label: undefined, icon: "ph-leaf" });
  });

  it("the phone sends snake_case params and keeps icon: null", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    globalThis.fetch = fetchMock;
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    globalThis.location = { protocol: "https:", host: "pc.tail.ts.net" };
    globalThis.window = {};
    await new HttpTransport().call("set_machine_profile", { machineId: null, clearIcon: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      method: "set_machine_profile",
      params: { machine_id: null, icon: null },
    });
  });
});
