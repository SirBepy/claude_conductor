import { defineConfig, devices } from "@playwright/test";

// View-harness config (iterate-it P6, 2026-07-12). Drives ONE SPA view in a
// plain browser against a mocked backend - see e2e/view-harness/harness.ts.
//
// Deliberately separate from the WebdriverIO layer (e2e/wdio.conf.js), which
// still boots the whole Tauri binary for native/tray/capabilities coverage a
// browser can't reach. Disjoint deps, config, and scripts - no collision.
//
// vite runs on 4420 by default (NEVER 1420, which Joe's live `cargo tauri dev`
// owns), and via the raw vite binary so the `predev` kill-stale hook - which
// would kill a running daemon - never fires. reuseExistingServer keeps a
// harness vite up across runs.
//
// VIEW_HARNESS_PORT overrides the port so two playwright runs (parallel
// builders, two chats) can each own a vite instead of fighting over 4420.
const port = Number(process.env.VIEW_HARNESS_PORT) || 4420;
const origin = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e/view-harness",
  testMatch: "**/*.view.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: origin,
    // main.ts calls `new Notification(...)`; grant so it never throws on a
    // permission prompt during boot.
    permissions: ["notifications"],
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `node node_modules/vite/bin/vite.js --port ${port} --strictPort`,
    url: origin,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
