// @vitest-environment jsdom
//
// The new-chat machine chips carry the same icon the sidebar rows give each
// machine (machine-icons.ts), in front of the machine's name.

import { describe, it, expect } from "vitest";

const { renderMachineFieldHtml } = await import("../src/views/sessions/machine-field.ts");

const SELF = { machine_id: "pc-id", label: "Main_Desktop", os: "windows" };
const peer = (machine_id, label, os) => ({
  machine_id, label, os, iroh_id: null, direct_url: null, reverse_device_id: null, added_at: 0, reach: "iroh",
});

function chips(peers) {
  const host = document.createElement("div");
  host.innerHTML = renderMachineFieldHtml({ machineId: null }, { self: SELF, peers });
  return [...host.querySelectorAll(".machine-chip")];
}

describe("machine chips", () => {
  it("each chip leads with its machine's OS logo, then the name", () => {
    const [self, mac] = chips([peer("mac-id", "mac", "macos")]);
    expect(self.querySelector("i").classList.contains("ph-windows-logo")).toBe(true);
    expect(self.textContent).toBe("Main_Desktop");
    expect(mac.querySelector("i").classList.contains("ph-apple-logo")).toBe(true);
    expect(mac.textContent).toBe("mac");
  });

  it("a second Mac's chip gets its own icon, not a second Apple logo", () => {
    const [, mac, studio] = chips([peer("mac-id", "mac", "macos"), peer("studio-id", "studio", "macos")]);
    expect(mac.querySelector("i").classList.contains("ph-apple-logo")).toBe(true);
    expect(studio.querySelector("i").classList.contains("ph-apple-logo")).toBe(false);
  });
});
