import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only pick up JS tests; cargo test owns the Rust ones at tauri/tests/*.rs.
    include: ["tests/**/*.test.mjs"],
    environment: "node",
    // Every spec sends at once unless it opts into the grace window itself.
    setupFiles: ["tests/setup/no-send-grace.mjs"],
  },
});
