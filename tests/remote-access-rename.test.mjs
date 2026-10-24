// @vitest-environment jsdom
// Paired devices and paired machines can be renamed inline: the name is an
// input that saves on blur/Enter, reverts on Escape, an empty name, or a
// failed save, and is plain text on the phone, which can't rename.

import { describe, it, expect, vi, beforeEach } from "vitest";

const PHONE = { id: "dev-1", name: "Phone", created_at: 0, kind: "phone", last_used: null };
const MAC = { machine_id: "mac-id", label: "mac", os: "macos", reach: null, can_drive: true };

const api = {
  remoteAccessStatus: vi.fn(async () => ({ enabled: true })),
  setRemoteAccessEnabled: vi.fn(async () => {}),
  remoteAccessQr: vi.fn(async () => ({ svg: "<svg></svg>", url: "conductor://pair?iroh=x&pair=y", iroh: "x" })),
  listRemoteDevices: vi.fn(async () => [PHONE]),
  revokeRemoteDevice: vi.fn(async () => true),
  renameRemoteDevice: vi.fn(async () => true),
  listMachines: vi.fn(async () => ({ self: { machine_id: "pc-id", label: "PC", os: "windows" }, peers: [MAC] })),
  setMachineCanDrive: vi.fn(async () => ({ ok: true })),
  renameMachine: vi.fn(async () => ({ ok: true })),
};
vi.mock("../src/shared/api.ts", () => ({ api }));
let remote = false;
vi.mock("../src/shared/transport.ts", () => ({
  isRemote: () => remote,
  getTransport: () => ({ listen: async () => () => {} }),
}));

const { renderRemoteAccessView } = await import(
  "../src/views/settings/subviews/remote-access/remote-access.ts"
);

async function mount() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const dispose = await renderRemoteAccessView(root);
  await vi.waitFor(() => expect(root.querySelector("#ra-device-list .ra-device-row")).not.toBeNull());
  await vi.waitFor(() => expect(root.querySelector("#ra-machine-list .ra-device-row")).not.toBeNull());
  return { root, dispose };
}

const field = (root, list, id) => root.querySelector(`${list} .ra-name-input[data-id="${id}"]`);

function type(input, value) {
  input.focus();
  input.value = value;
  input.blur();
}

beforeEach(() => {
  remote = false;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("Remote access: inline rename", () => {
  it("renames a paired device, trimmed", async () => {
    const { root, dispose } = await mount();
    const input = field(root, "#ra-device-list", "dev-1");
    expect(input.value).toBe("Phone");
    type(input, "  Pixel 9  ");
    await vi.waitFor(() => expect(api.renameRemoteDevice).toHaveBeenCalledWith("dev-1", "Pixel 9"));
    expect(input.value).toBe("Pixel 9");
    dispose?.();
  });

  it("renames a paired machine", async () => {
    const { root, dispose } = await mount();
    type(field(root, "#ra-machine-list", "mac-id"), "Studio");
    await vi.waitFor(() => expect(api.renameMachine).toHaveBeenCalledWith("mac-id", "Studio"));
    dispose?.();
  });

  it("does not save an empty or unchanged name, and puts the old one back", async () => {
    const { root, dispose } = await mount();
    const input = field(root, "#ra-device-list", "dev-1");
    type(input, "   ");
    expect(input.value).toBe("Phone");
    type(input, "Phone");
    expect(api.renameRemoteDevice).not.toHaveBeenCalled();
    dispose?.();
  });

  it("Escape reverts without saving", async () => {
    const { root, dispose } = await mount();
    const input = field(root, "#ra-machine-list", "mac-id");
    input.focus();
    input.value = "Nope";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(input.value).toBe("mac");
    expect(api.renameMachine).not.toHaveBeenCalled();
    dispose?.();
  });

  it("puts the old name back when the save fails", async () => {
    api.renameMachine.mockRejectedValueOnce(new Error("daemon down"));
    const { root, dispose } = await mount();
    const input = field(root, "#ra-machine-list", "mac-id");
    type(input, "Studio");
    await vi.waitFor(() => expect(input.value).toBe("mac"));
    dispose?.();
  });

  it("leaves a machine's device entry read-only, since its name follows the machine nickname", async () => {
    api.listRemoteDevices.mockResolvedValueOnce([PHONE, { id: "dev-m", name: "mac", created_at: 0, kind: "machine", last_used: null }]);
    const { root, dispose } = await mount();
    expect(field(root, "#ra-device-list", "dev-1")).not.toBeNull();
    expect(field(root, "#ra-device-list", "dev-m")).toBeNull();
    expect(root.querySelector('#ra-device-list .ra-device-row[data-id="dev-m"] .ra-device-name').textContent).toBe("mac");
    dispose?.();
  });

  it("shows plain names on the phone", async () => {
    remote = true;
    const root = document.createElement("div");
    document.body.appendChild(root);
    const dispose = await renderRemoteAccessView(root);
    await vi.waitFor(() => expect(root.querySelector("#ra-machine-list .ra-device-row")).not.toBeNull());
    expect(root.querySelector(".ra-name-input")).toBeNull();
    expect(root.querySelector("#ra-machine-list .ra-device-name").textContent).toBe("mac");
    dispose?.();
  });
});
