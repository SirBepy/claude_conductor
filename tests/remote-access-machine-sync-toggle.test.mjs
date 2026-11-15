// @vitest-environment jsdom
// asserts: src/views/settings/subviews/remote-access/machines-section.ts
// Each paired-machine row carries a "Sync settings" switch beside "Can drive
// chats": it reflects the daemon's sync_settings (off when absent), saves on
// change, and snaps back when the save fails.

import { describe, it, expect, vi, beforeEach } from "vitest";

const MAC = { machine_id: "mac-id", label: "mac", os: "macos", reach: null, can_drive: true };
const LAPTOP = { machine_id: "lap-id", label: "Laptop", os: "windows", reach: null, can_drive: true, sync_settings: true };

const api = {
  remoteAccessStatus: vi.fn(async () => ({ enabled: true })),
  setRemoteAccessEnabled: vi.fn(async () => {}),
  remoteAccessQr: vi.fn(async () => ({ svg: "<svg></svg>", url: "conductor://pair?iroh=x&pair=y", iroh: "x" })),
  listRemoteDevices: vi.fn(async () => []),
  revokeRemoteDevice: vi.fn(async () => true),
  listMachines: vi.fn(async () => ({ self: { machine_id: "pc-id", label: "PC", os: "windows" }, peers: [MAC, LAPTOP] })),
  setMachineCanDrive: vi.fn(async () => ({ ok: true })),
  setMachineSyncSettings: vi.fn(async () => ({ ok: true })),
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
  await vi.waitFor(() => expect(root.querySelector('.ra-machine-sync-input[data-id="lap-id"]')).not.toBeNull());
  return { root, dispose };
}

const toggle = (root, id) => root.querySelector(`.ra-machine-sync-input[data-id="${id}"]`);

beforeEach(() => {
  remote = false;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("Paired machines: sync-settings switch", () => {
  it("is off for a peer that never turned it on and on for one that did", async () => {
    const { root, dispose } = await mount();
    expect(toggle(root, "mac-id").checked).toBe(false);
    expect(toggle(root, "lap-id").checked).toBe(true);
    dispose?.();
  });

  it("sits beside the drive switch and is a separate control", async () => {
    const { root, dispose } = await mount();
    const row = root.querySelector('.ra-device-row[data-id="mac-id"]');
    expect(row.querySelectorAll(".ra-machine-drive").length).toBe(2);
    expect(row.querySelector(".ra-machine-drive-input")).not.toBe(row.querySelector(".ra-machine-sync-input"));
    dispose?.();
  });

  it("saves the new value for that peer and never touches the drive switch call", async () => {
    const { root, dispose } = await mount();
    const input = toggle(root, "mac-id");
    input.checked = true;
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(api.setMachineSyncSettings).toHaveBeenCalledWith("mac-id", true));
    await vi.waitFor(() => expect(input.disabled).toBe(false));
    expect(input.checked).toBe(true);
    expect(api.setMachineCanDrive).not.toHaveBeenCalled();
    dispose?.();
  });

  it("snaps back when the save fails", async () => {
    api.setMachineSyncSettings.mockRejectedValueOnce(new Error("daemon down"));
    const { root, dispose } = await mount();
    const input = toggle(root, "mac-id");
    input.checked = true;
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(input.disabled).toBe(false));
    expect(input.checked).toBe(false);
    dispose?.();
  });

  it("shows why settings are not flowing (a clock difference) on that peer's row only", async () => {
    api.listMachines.mockResolvedValueOnce({
      self: { machine_id: "pc-id", label: "PC", os: "windows" },
      peers: [MAC, { ...LAPTOP, settings_note: "Clocks differ by over 5 minutes: its settings changes are refused here until they agree" }],
    });
    const { root, dispose } = await mount();
    const note = root.querySelector('.ra-device-row[data-id="lap-id"] .ra-machine-settings-note');
    expect(note?.textContent).toContain("Clocks differ by over 5 minutes");
    expect(root.querySelector('.ra-device-row[data-id="mac-id"] .ra-machine-settings-note')).toBeNull();
    dispose?.();
  });

  it("is absent on the phone, which can't flip it", async () => {
    remote = true;
    const root = document.createElement("div");
    document.body.appendChild(root);
    const dispose = await renderRemoteAccessView(root);
    await vi.waitFor(() => expect(root.querySelector('.ra-device-row[data-id="lap-id"]')).not.toBeNull());
    expect(root.querySelector(".ra-machine-sync-input")).toBeNull();
    dispose?.();
  });
});
