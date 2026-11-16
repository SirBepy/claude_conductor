import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only pick up JS tests; cargo test owns the Rust ones at tauri/tests/*.rs.
    include: ["tests/**/*.test.mjs"],
    environment: "node",
    // Vitest 2.x defaults to forks sized cores-1: one run measured 19 node workers
    // (~23% of a 20-core PC). Global cap of 5 workers; the forks pool ignores the
    // poolOptions.threads.* flags.
    pool: "forks",
    poolOptions: { forks: { maxForks: 5, minForks: 1 } },
  },
});
