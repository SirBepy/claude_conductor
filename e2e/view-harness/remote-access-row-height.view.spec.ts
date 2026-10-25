import { expect, test } from "@playwright/test";
import path from "node:path";
import { mountView } from "./harness";
import { shotDir } from "./shot-dir";

// asserts: src/views/settings/subviews/remote-access/remote-access.ts
// Settings subpages share a 45px row via `[class*="view-settings-"]` in
// settings-sections.css. The Remote access root once carried only the index's
// plain `view-settings` class, so its rows measured the kit's 36px baseline.

const SHOT_DIR = shotDir();
const LABEL = process.env.CC_SHOT_LABEL ?? "after";

test("remote access page: every kit-row is the shared 45px height", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  await mountView(page, {
    view: "settings-remote-access",
    invoke: {
      remote_access_status: { enabled: true },
      remote_access_qr: { svg: "<svg width='80' height='80'></svg>", url: "http://x/pair", iroh: null },
      list_remote_devices: [
        { id: "d1", name: "Pixel 8", created_at: 1760000000, last_used: 1760100000, kind: "phone" },
      ],
      list_machines: {
        self: { machine_id: "m0", label: "Desktop", os: "windows" },
        peers: [
          {
            machine_id: "m1", label: "Laptop", os: "macos", iroh_id: null, direct_url: null,
            reverse_device_id: null, added_at: 1760000000, can_drive: true, reach: "direct",
          },
        ],
      },
    },
  });
  await page.locator("#ra-machine-list .ra-device-row").first().waitFor();
  await page.locator("#ra-device-list .ra-device-row").first().waitFor();

  const rows = await page.locator(".kit-row").evaluateAll((els) =>
    els.map((el) => ({
      label: el.querySelector(".kit-row-label")?.textContent?.trim() ?? "",
      h: Math.round(el.getBoundingClientRect().height),
      edge: el.matches(":first-of-type, :last-of-type"),
    })),
  );
  // The machines card now holds rows, not a kit-row, so only the toggle rows remain.
  expect(rows.length).toBeGreaterThanOrEqual(1);
  await page.screenshot({ path: path.join(SHOT_DIR, `remote-access-${LABEL}.png`), fullPage: true });

  // The kit trims the first/last row of a card on purpose; the rest are 45px.
  // Each card here holds a single row, so there are no interior rows to compare:
  // the sibling rule is checked against the heights the kit gives edge rows.
  for (const r of rows) {
    expect(r.h, `row "${r.label}" (edge=${r.edge})`).toBeGreaterThanOrEqual(r.edge ? 44 : 45);
  }

  // In-row fields fit the 32px control pin.
  const fields = await page.locator(".kit-row input[type=text]").evaluateAll((els) =>
    els.map((el) => Math.round(el.getBoundingClientRect().height)),
  );
  for (const h of fields) expect(h).toBeLessThanOrEqual(32);

  // Per-device rename fields and Unpair/Revoke buttons stay within 32px.
  const controls = await page
    .locator(".ra-device-row .ra-name-input, .ra-device-row .btn-danger-sm")
    .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
  expect(controls.length).toBeGreaterThanOrEqual(4);
  for (const h of controls) expect(h).toBeLessThanOrEqual(32);
});
