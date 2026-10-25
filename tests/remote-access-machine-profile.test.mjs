// @vitest-environment jsdom
// Settings > Remote access > Paired machines: one row per machine, this one
// included, each with an icon picker and a name field that save through
// set_machine_profile (null id = this machine). Editable on the phone too.

import { describe, it, expect, vi, beforeEach } from "vitest";

const MAC = { machine_id: "mac-id", label: "mac", os: "macos", icon: null, reach: null, can_drive: true };

const api = {
  remoteAccessStatus: vi.fn(async () => ({ enabled: true })),
  setRemoteAccessEnabled: vi.fn(async () => {}),
  remoteAccessQr: vi.fn(async () => ({ svg: "<svg></svg>", url: "conductor://pair?iroh=x&pair=y", iroh: "x" })),
  listRemoteDevices: vi.fn(async () => []),
  revokeRemoteDevice: vi.fn(async () => true),
  listMachines: vi.fn(async () => ({ self: { machine_id: "pc-id", label: "PC", os: "windows", icon: "ph-rocket-launch" }, peers: [MAC] })),
  setMachineCanDrive: vi.fn(async () => ({ ok: true })),
  setMachineProfile: vi.fn(async () => ({ ok: true })),
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
  await vi.waitFor(() => expect(root.querySelector('#ra-machine-list .ra-device-row[data-id="mac-id"]')).not.toBeNull());
  return { root, dispose };
}

const row = (root, id) => root.querySelector(`#ra-machine-list .ra-device-row[data-id="${id}"]`);
const nameOf = (root, id) => row(root, id).querySelector(".ra-name-input");
const btnOf = (root, id) => row(root, id).querySelector(".ra-icon-btn");

function type(input, value) {
  input.focus();
  input.value = value;
  input.blur();
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  // A grid left open by the previous test would make the list skip its render.
  // The popover arms its dismiss listeners on a timer, so wait one tick first.
  await tick();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  remote = false;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("Paired machines: unified rows", () => {
  it("renders this machine as a row with a name field and an icon button showing its chosen icon", async () => {
    const { root, dispose } = await mount();
    expect(nameOf(root, "pc-id").value).toBe("PC");
    expect(btnOf(root, "pc-id").querySelector("i").className).toContain("ph-rocket-launch");
    // The peer has no chosen icon, so it shows the automatic OS logo.
    expect(btnOf(root, "mac-id").querySelector("i").className).toContain("ph-apple-logo");
    // This machine has no drive switch or Unpair.
    expect(row(root, "pc-id").querySelector(".ra-unpair-btn")).toBeNull();
    expect(row(root, "mac-id").querySelector(".ra-unpair-btn")).not.toBeNull();
    dispose?.();
  });

  it("commits this machine's name with a null id", async () => {
    const { root, dispose } = await mount();
    type(nameOf(root, "pc-id"), "Desk");
    await vi.waitFor(() => expect(api.setMachineProfile).toHaveBeenCalledWith(null, { label: "Desk" }));
    dispose?.();
  });

  it("commits a peer's name with the peer id", async () => {
    const { root, dispose } = await mount();
    type(nameOf(root, "mac-id"), "Studio");
    await vi.waitFor(() => expect(api.setMachineProfile).toHaveBeenCalledWith("mac-id", { label: "Studio" }));
    dispose?.();
  });
});

describe("Paired machines: icon picker", () => {
  it("picking an icon saves it for that peer and closes the grid", async () => {
    const { root, dispose } = await mount();
    btnOf(root, "mac-id").click();
    const pop = document.querySelector(".ra-icon-pop");
    expect(pop).not.toBeNull();
    pop.querySelector('[data-icon="ph-leaf"]').click();
    await vi.waitFor(() => expect(api.setMachineProfile).toHaveBeenCalledWith("mac-id", { icon: "ph-leaf" }));
    expect(document.querySelector(".ra-icon-pop")).toBeNull();
    dispose?.();
  });

  it("picking an icon for this machine uses a null id", async () => {
    const { root, dispose } = await mount();
    btnOf(root, "pc-id").click();
    document.querySelector('.ra-icon-pop [data-icon="ph-cube"]').click();
    await vi.waitFor(() => expect(api.setMachineProfile).toHaveBeenCalledWith(null, { icon: "ph-cube" }));
    dispose?.();
  });

  it("Automatic sends a null icon", async () => {
    const { root, dispose } = await mount();
    btnOf(root, "pc-id").click();
    const auto = document.querySelector(".ra-icon-pop .ra-icon-auto");
    expect(auto.classList.contains("active")).toBe(false);
    auto.click();
    await vi.waitFor(() => expect(api.setMachineProfile).toHaveBeenCalledWith(null, { icon: null }));
    dispose?.();
  });

  it("marks the chosen icon and never repeats a glyph", async () => {
    const { root, dispose } = await mount();
    btnOf(root, "pc-id").click();
    const cells = [...document.querySelectorAll(".ra-icon-pop .ra-icon-cell")];
    const ids = cells.map((c) => c.dataset.icon);
    expect(new Set(ids).size).toBe(ids.length);
    expect(cells.filter((c) => c.classList.contains("active")).map((c) => c.dataset.icon)).toEqual(["ph-rocket-launch"]);
    dispose?.();
  });

  it("Escape closes the grid without saving", async () => {
    const { root, dispose } = await mount();
    btnOf(root, "mac-id").click();
    expect(document.querySelector(".ra-icon-pop")).not.toBeNull();
    await tick();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".ra-icon-pop")).toBeNull();
    expect(api.setMachineProfile).not.toHaveBeenCalled();
    dispose?.();
  });
});

describe("Paired machines on the phone", () => {
  it("keeps the name and icon editable", async () => {
    remote = true;
    const { root, dispose } = await mount();
    type(nameOf(root, "pc-id"), "Desk");
    await vi.waitFor(() => expect(api.setMachineProfile).toHaveBeenCalledWith(null, { label: "Desk" }));
    btnOf(root, "mac-id").click();
    document.querySelector('.ra-icon-pop [data-icon="ph-moon-stars"]').click();
    await vi.waitFor(() => expect(api.setMachineProfile).toHaveBeenCalledWith("mac-id", { icon: "ph-moon-stars" }));
    dispose?.();
  });
});
