// @vitest-environment jsdom

// The shared "open the calendar" entry point: its own window on desktop, the
// in-app route where there is no window concept (browser/remote build).

import { describe, it, expect, vi, afterEach } from "vitest";

const invokeMock = vi.fn(async () => {});
const showViewMock = vi.fn();
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));
vi.mock("../src/shared/navigation.ts", () => ({ showView: (...a) => showViewMock(...a) }));

const { openSchedule } = await import("../src/shared/open-schedule.ts");

afterEach(() => {
  delete window.__TAURI__;
  invokeMock.mockClear();
  showViewMock.mockClear();
});

describe("openSchedule", () => {
  it("opens the standalone window on desktop", () => {
    window.__TAURI__ = {};
    openSchedule();
    expect(invokeMock).toHaveBeenCalledWith("open_schedule_window");
    expect(showViewMock).not.toHaveBeenCalled();
  });

  it("routes in-place without Tauri", () => {
    openSchedule();
    expect(showViewMock).toHaveBeenCalledWith("schedule");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("logs a failed window open instead of throwing", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    window.__TAURI__ = {};
    invokeMock.mockRejectedValueOnce("no window");
    openSchedule();
    await new Promise((r) => setTimeout(r, 0));
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
