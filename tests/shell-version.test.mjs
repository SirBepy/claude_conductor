// @vitest-environment jsdom

// The Android shell tells the daemon-served SPA its own version through a
// `?shellv=` URL param; the SPA keeps it for Settings > About on the phone.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

vi.mock("../src/shared/api.ts", () => ({ api: {} }));

const { captureShellVersion, readShellVersion, SHELL_VERSION_KEY } = await import("../src/shared/shell-version.ts");
const { phoneVersionLines } = await import("../src/views/settings/subviews/about/about.ts");

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/");
});

describe("captureShellVersion", () => {
  it("stores the shell version and removes it from the address, keeping other params", () => {
    history.replaceState(null, "", "/?shellv=0.2.145&x=1#top");
    captureShellVersion();
    expect(localStorage.getItem(SHELL_VERSION_KEY)).toBe("0.2.145");
    expect(location.search).toBe("?x=1");
    expect(location.hash).toBe("#top");
  });

  it("keeps the stored version across an in-page reload that no longer carries the param", () => {
    history.replaceState(null, "", "/?shellv=0.2.145");
    captureShellVersion();
    captureShellVersion();
    expect(readShellVersion()).toBe("0.2.145");
  });

  it("replaces an older stored version when the updated shell reports a new one", () => {
    localStorage.setItem(SHELL_VERSION_KEY, "0.2.100");
    history.replaceState(null, "", "/?shellv=0.2.145");
    captureShellVersion();
    expect(readShellVersion()).toBe("0.2.145");
  });

  it("stores nothing when an older shell never sends the param", () => {
    captureShellVersion();
    expect(readShellVersion()).toBeNull();
  });
});

describe("phoneVersionLines", () => {
  it("prefixes numeric versions and leaves local-build as is", () => {
    expect(phoneVersionLines("0.2.145", "0.2.145")).toEqual({ pc: "v0.2.145", phone: "v0.2.145" });
    expect(phoneVersionLines("local-build", "0.2.1").pc).toBe("local-build");
  });

  it("says the phone app version was not reported when the shell never sent one", () => {
    expect(phoneVersionLines("0.2.145", null).phone).toMatch(/Not reported/);
  });
});

describe("android shell handoff", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "android", "src", "app.js"), "utf8");

  it("leaves for the SPA only through handoff(), which attaches the shell version", () => {
    const assignments = src.match(/window\.location\.href\s*=/g) ?? [];
    expect(assignments).toHaveLength(1);
    const handoff = src.slice(src.indexOf("async function handoff"));
    expect(handoff.indexOf("window.location.href")).toBeGreaterThan(0);
    expect(handoff).toMatch(/searchParams\.set\("shellv"/);
  });
});
