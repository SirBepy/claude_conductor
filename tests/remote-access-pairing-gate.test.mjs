// @vitest-environment jsdom
// The pairing section (QR + Copy link) follows the one remote-access
// switch alone. It used to also need Tailscale up, which hid Copy link on a Mac
// with no Tailscale even though the iroh-only link was ready.

import { describe, it, expect, vi, beforeEach } from "vitest";

let status = { enabled: true };
const api = {
  remoteAccessStatus: vi.fn(async () => status),
  setRemoteAccessEnabled: vi.fn(async (enabled) => { status = { enabled }; }),
  remoteAccessQr: vi.fn(async () => ({
    svg: "<svg id='qr-svg'></svg>",
    url: "conductor://pair?iroh=deadbeef&pair=abc",
    iroh: "deadbeef",
  })),
  listRemoteDevices: vi.fn(async () => []),
  revokeRemoteDevice: vi.fn(async () => true),
  listMachines: vi.fn(async () => ({ self: null, peers: [] })),
};
vi.mock("../src/shared/api.ts", () => ({ api }));

const { renderRemoteAccessView } = await import(
  "../src/views/settings/subviews/remote-access/remote-access.ts"
);

async function mount() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  await renderRemoteAccessView(root);
  return root;
}

beforeEach(() => {
  document.body.innerHTML = "";
  status = { enabled: true };
  vi.clearAllMocks();
});

describe("remote access pairing section", () => {
  it("shows the QR and Copy link whenever the switch is on, with no Tailscale field at all", async () => {
    const root = await mount();
    expect(root.querySelector("#ra-qr-section").style.display).toBe("");
    expect(root.querySelector("#ra-qr #qr-svg")).not.toBeNull();
    expect(root.querySelector("#ra-copy-url").style.display).toBe("");
  });

  it("hides the pairing section and mints no code while the switch is off", async () => {
    status = { enabled: false };
    const root = await mount();
    expect(root.querySelector("#ra-qr-section").style.display).toBe("none");
    expect(api.remoteAccessQr).not.toHaveBeenCalled();
  });

  it("has one switch: no separate block-all toggle, no Tailscale wording", async () => {
    const root = await mount();
    expect(root.querySelectorAll("input[type=checkbox]").length).toBe(1);
    expect(root.textContent.toLowerCase()).not.toContain("tailscale");
  });

  it("flipping the switch on reveals the pairing section", async () => {
    status = { enabled: false };
    const root = await mount();
    const toggle = root.querySelector("#ra-enabled");
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(root.querySelector("#ra-qr-section").style.display).toBe(""));
    expect(api.setRemoteAccessEnabled).toHaveBeenCalledWith(true);
  });
});
