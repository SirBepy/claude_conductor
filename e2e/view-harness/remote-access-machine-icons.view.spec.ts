import { expect, test } from "@playwright/test";
import path from "node:path";
import { mountView } from "./harness";
import { shotDir } from "./shot-dir";

// asserts: src/views/settings/subviews/remote-access/machines-section.ts, src/views/settings/subviews/remote-access/icon-picker.ts
// Paired machines: this machine and each peer share one row layout (icon
// button, name field, then the peer's controls), and the icon button opens a grid.

const SHOT_DIR = shotDir();

test("machine rows carry an icon button and the grid opens anchored to it", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  await mountView(page, {
    view: "settings-remote-access",
    invoke: {
      remote_access_status: { enabled: true },
      remote_access_qr: { svg: "<svg width='80' height='80'></svg>", url: "http://x/pair", iroh: null },
      list_remote_devices: [],
      list_machines: {
        self: { machine_id: "m0", label: "Desktop", os: "windows", icon: "ph-rocket-launch" },
        peers: [
          {
            machine_id: "m1", label: "Laptop", os: "macos", icon: null, iroh_id: null, direct_url: null,
            reverse_device_id: null, added_at: 1760000000, can_drive: true, reach: "direct",
          },
        ],
      },
    },
  });
  const rows = page.locator("#ra-machine-list .ra-device-row");
  await rows.nth(1).waitFor();
  await expect(rows.locator(".ra-icon-btn")).toHaveCount(2);
  await page.screenshot({ path: path.join(SHOT_DIR, "machine-icons-rows.png"), fullPage: true });

  await rows.nth(1).locator(".ra-icon-btn").click();
  const pop = page.locator(".ra-icon-pop");
  await pop.waitFor();
  await page.screenshot({ path: path.join(SHOT_DIR, "machine-icons-grid.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
});
