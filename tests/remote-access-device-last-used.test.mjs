// @vitest-environment jsdom
// asserts: src/views/settings/subviews/remote-access/remote-access.ts
// The paired-device list shows when each device last authenticated, so a
// device Joe does not recognise stands out.

import { describe, it, expect, vi, beforeEach } from "vitest";

const DAY = 86400;
let devices = [];
const api = {
  remoteAccessStatus: vi.fn(async () => ({ enabled: true })),
  setRemoteAccessEnabled: vi.fn(async () => {}),
  remoteAccessQr: vi.fn(async () => ({ svg: "<svg></svg>", url: "conductor://pair", iroh: null })),
  listRemoteDevices: vi.fn(async () => devices),
  revokeRemoteDevice: vi.fn(async () => true),
  listMachines: vi.fn(async () => ({ self: null, peers: [] })),
};
vi.mock("../src/shared/api.ts", () => ({ api }));

const { renderRemoteAccessView, lastUsedLabel } = await import(
  "../src/views/settings/subviews/remote-access/remote-access.ts"
);

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("device list last used", () => {
  it("renders the last-used date on each row and 'not yet' when unknown", async () => {
    const used = Math.floor(Date.UTC(2026, 9, 1, 12) / 1000);
    devices = [
      { id: "a", name: "Pixel", created_at: used - 30 * DAY, last_used: used },
      { id: "b", name: "Old phone", created_at: used - 300 * DAY, last_used: null },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    await renderRemoteAccessView(root);
    const rows = root.querySelectorAll(".ra-device-row");
    expect(rows.length).toBe(2);
    const dates = [...root.querySelectorAll(".ra-device-date")].map((e) => e.textContent);
    expect(dates[0]).toContain(`last used ${new Date(used * 1000).toLocaleDateString()}`);
    expect(dates[1]).toContain("last used not yet");
  });

  it("lastUsedLabel treats 0/null/undefined as unknown", () => {
    expect(lastUsedLabel(null)).toBe("not yet");
    expect(lastUsedLabel(undefined)).toBe("not yet");
    expect(lastUsedLabel(0)).toBe("not yet");
  });
});
