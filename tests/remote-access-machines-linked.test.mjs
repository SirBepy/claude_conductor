// @vitest-environment jsdom
// A pair started on the OTHER machine reaches this Settings page only through
// the daemon's machines-changed event: the list refreshes, the new peer's row
// is marked, and a "Linked with" line names it. Machines already paired when
// the page opened are never announced.

import { describe, it, expect, vi, beforeEach } from "vitest";

const MAC = { machine_id: "mac-id", label: "mac", os: "macos", reach: null };
const OLD = { machine_id: "old-id", label: "Old Laptop", os: "windows", reach: null };

let peers = [];
let onMachinesChanged = null;
const api = {
  remoteAccessStatus: vi.fn(async () => ({ enabled: true })),
  setRemoteAccessEnabled: vi.fn(async () => {}),
  remoteAccessQr: vi.fn(async () => ({ svg: "<svg></svg>", url: "conductor://pair?iroh=x&pair=y", iroh: "x" })),
  listRemoteDevices: vi.fn(async () => []),
  revokeRemoteDevice: vi.fn(async () => true),
  listMachines: vi.fn(async () => ({ self: { machine_id: "pc-id", label: "PC", os: "windows" }, peers })),
};
vi.mock("../src/shared/api.ts", () => ({ api }));
vi.mock("../src/shared/transport.ts", () => ({
  isRemote: () => false,
  getTransport: () => ({
    listen: async (event, cb) => {
      if (event === "machines-changed") onMachinesChanged = cb;
      return () => { onMachinesChanged = null; };
    },
  }),
}));

const { renderRemoteAccessView } = await import(
  "../src/views/settings/subviews/remote-access/remote-access.ts"
);

async function mount() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const dispose = await renderRemoteAccessView(root);
  await vi.waitFor(() => expect(onMachinesChanged).not.toBeNull());
  return { root, dispose };
}

beforeEach(() => {
  document.body.innerHTML = "";
  peers = [];
  onMachinesChanged = null;
  vi.clearAllMocks();
});

describe("Paired machines: live link from the other side", () => {
  it("shows the newly linked machine, marks its row, and names it", async () => {
    const { root, dispose } = await mount();
    expect(root.querySelector("#ra-machine-linked").hidden).toBe(true);

    peers = [MAC];
    onMachinesChanged({});

    await vi.waitFor(() => expect(root.querySelector('.ra-device-row[data-id="mac-id"]')).not.toBeNull());
    const linked = root.querySelector("#ra-machine-linked");
    expect(linked.hidden).toBe(false);
    expect(linked.textContent).toContain("Linked with mac");
    expect(root.querySelector('.ra-device-row[data-id="mac-id"]').classList.contains("ra-row-new")).toBe(true);
    // The pairing code the other side just used is consumed, so a fresh one is minted.
    expect(api.remoteAccessQr).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("does not announce machines that were already paired when the page opened", async () => {
    peers = [OLD];
    const { root, dispose } = await mount();
    onMachinesChanged({});
    await vi.waitFor(() => expect(api.listMachines).toHaveBeenCalledTimes(2));
    expect(root.querySelector("#ra-machine-linked").hidden).toBe(true);
    expect(root.querySelector('.ra-device-row[data-id="old-id"]').classList.contains("ra-row-new")).toBe(false);
    dispose();
  });

  it("stops listening once the view is closed", async () => {
    const { dispose } = await mount();
    dispose();
    expect(onMachinesChanged).toBeNull();
  });
});
