// asserts: src/shared/global-stream.ts
// asserts: src/shared/boot.ts
// asserts: src-tauri/src/daemon_link/mod.rs
// The daemon's `ram_warning` notification has to reach a toast on desktop (the
// daemon_link forward) and on the phone (the global stream map), and boot must
// wire the toast for the window that owns app toasts.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(p, "utf8");

describe("ram warning wiring", () => {
  it("maps the daemon event on the phone's global stream", () => {
    expect(read("src/shared/global-stream.ts")).toMatch(/ram_warning:\s*"ram-warning"/);
  });
  it("forwards the daemon event to the desktop window", () => {
    expect(read("src-tauri/src/daemon_link/mod.rs")).toMatch(/"ram_warning"\s*=>\s*\{\s*let _ = app\.emit\("ram-warning"/);
  });
  it("wires the toast only through the toast-owning window", () => {
    expect(read("src/shared/boot.ts")).toContain("wireRamWarningToasts(ownsToasts)");
    expect(read("src/shared/daemon-status-toast.ts")).toMatch(/if \(!ownsToasts\) return;\s*api\.onRamWarning/);
  });
});
