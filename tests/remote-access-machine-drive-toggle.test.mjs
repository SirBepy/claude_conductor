// @vitest-environment jsdom
// Each paired-machine row carries the "Can drive chats" switch: it reflects
// the daemon's can_drive, saves on change, and snaps back when the save fails
// (the daemon still holds the old value).

import { describe, it, expect, vi, beforeEach } from "vitest";

const MAC = { machine_id: "mac-id", label: "mac", os: "macos", reach: null, can_drive: true };
const LAPTOP = { machine_id: "lap-id", label: "Laptop", os: "windows", reach: null, can_drive: false };

const api = {
  remoteAccessStatus: vi.fn(async () => ({ enabled: true })),
  setRemoteAccessEnabled: vi.fn(async () => {}),
  remoteAccessQr: vi.fn(async () => ({ svg: "<svg></svg>", url: "conductor://pair?iroh=x&pair=y", iroh: "x" })),
  listRemoteDevices: vi.fn(async () => []),
  revokeRemoteDevice: vi.fn(async () => true),
  listMachines: vi.fn(async () => ({ self: { machine_id: "pc-id", label: "PC", os: "windows" }, peers: [MAC, LAPTOP] })),
  setMachineCanDrive: vi.fn(async () => ({ ok: true })),
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
  await vi.waitFor(() => expect(root.querySelector('.ra-machine-drive-input[data-id="lap-id"]')).not.toBeNull());
  return { root, dispose };
}

const toggle = (root, id) => root.querySelector(`.ra-machine-drive-input[data-id="${id}"]`);

beforeEach(() => {
  remote = false;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("Paired machines: can-drive switch", () => {
  it("reflects each peer's can_drive", async () => {
    const { root, dispose } = await mount();
    expect(toggle(root, "mac-id").checked).toBe(true);
    expect(toggle(root, "lap-id").checked).toBe(false);
    dispose?.();
  });

  it("saves the new value for that peer", async () => {
    const { root, dispose } = await mount();
    const input = toggle(root, "mac-id");
    input.checked = false;
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(api.setMachineCanDrive).toHaveBeenCalledWith("mac-id", false));
    await vi.waitFor(() => expect(input.disabled).toBe(false));
    expect(input.checked).toBe(false);
    dispose?.();
  });

  it("snaps back when the save fails", async () => {
    api.setMachineCanDrive.mockRejectedValueOnce(new Error("daemon down"));
    const { root, dispose } = await mount();
    const input = toggle(root, "lap-id");
    input.checked = true;
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(input.disabled).toBe(false));
    expect(input.checked).toBe(false);
    dispose?.();
  });

  it("is absent on the phone, which can't flip it", async () => {
    remote = true;
    const root = document.createElement("div");
    document.body.appendChild(root);
    const dispose = await renderRemoteAccessView(root);
    await vi.waitFor(() => expect(root.querySelector('.ra-device-row[data-id="lap-id"]')).not.toBeNull());
    expect(root.querySelector(".ra-machine-drive-input")).toBeNull();
    dispose?.();
  });
});
