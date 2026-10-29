// A slow chat-open phase has to reach the app log on desktop: release builds
// have no devtools, so `log_webview_perf` is the only way to diagnose a slow
// open on the installed app. The phone's HTTP transport has no such command,
// so it stays console-only.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { invoke, isRemote } = vi.hoisted(() => ({ invoke: vi.fn(), isRemote: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invoke(...a) }));
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => isRemote() }));

const { perfPhase } = await import("../src/shared/perf.ts");

/** Closes a phase that the clock says ran for `ms`. */
function runPhase(label, ms, detail) {
  let now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const done = perfPhase(label, detail);
  now += ms;
  done();
}

let warn;

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined);
  isRemote.mockReset().mockReturnValue(false);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("perf report routing", () => {
  it("on desktop, sends a slow phase's line to log_webview_perf as well as the console", () => {
    runPhase("chat-open", 400, () => "events=12");

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("log_webview_perf", { line: "[perf] chat-open took 400ms events=12" });
    expect(warn).toHaveBeenCalledWith("[perf] chat-open took 400ms events=12");
  });

  it("logs nothing for a phase under the slow threshold", () => {
    runPhase("chat-open", 100);

    expect(invoke).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("on the phone, stays console-only", () => {
    isRemote.mockReturnValue(true);

    runPhase("chat-open", 400);

    expect(invoke).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[perf] chat-open took 400ms");
  });

  it("swallows a rejected log_webview_perf invoke", async () => {
    invoke.mockRejectedValue(new Error("command not found"));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    expect(() => runPhase("chat-open", 400)).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    process.off("unhandledRejection", unhandled);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("swallows a missing transport (invoke throwing synchronously)", () => {
    invoke.mockImplementation(() => { throw new Error("no transport"); });

    expect(() => runPhase("chat-open", 400)).not.toThrow();
    expect(warn).toHaveBeenCalledWith("[perf] chat-open took 400ms");
  });
});
