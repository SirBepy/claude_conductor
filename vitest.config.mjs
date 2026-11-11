import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only pick up JS tests; cargo test owns the Rust ones at tauri/tests/*.rs.
    include: ["tests/**/*.test.mjs"],
    environment: "node",
  },
});
