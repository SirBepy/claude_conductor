// The sidemenu's Jarvis item and the Chats rail's Jarvis icon share one open
// path that never throws into a click handler.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { openJarvisMock } = vi.hoisted(() => ({ openJarvisMock: vi.fn() }));
vi.mock("../src/views/sessions/open-jarvis.ts", () => ({ openJarvis: () => openJarvisMock() }));

const { openJarvisSafely } = await import("../src/shared/open-jarvis-safely.ts");

beforeEach(() => {
  openJarvisMock.mockReset();
  vi.restoreAllMocks();
});

describe("openJarvisSafely", () => {
  it("opens Jarvis", async () => {
    openJarvisMock.mockResolvedValue(undefined);
    await openJarvisSafely();
    expect(openJarvisMock).toHaveBeenCalledTimes(1);
  });

  it("logs a failed open instead of rejecting", async () => {
    const err = new Error("no default account");
    openJarvisMock.mockRejectedValue(err);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(openJarvisSafely()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("[jarvis] open failed", err);
  });
});
