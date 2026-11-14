// @vitest-environment jsdom
//
// refreshSessions runs on every instances-changed frame, so a slow answer on the
// phone must not read as the user waiting ("Waiting for your PC"); only the
// first load of the list is a real wait and passes background=false.

import { describe, it, expect, vi, beforeEach } from "vitest";

globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);
if (!globalThis.CSS) globalThis.CSS = window.CSS ?? { escape: (s) => s };

const invoke = vi.hoisted(() => vi.fn(async () => []));
vi.mock("../src/shared/ipc.ts", () => ({ invoke }));

const { refreshSessions } = await import("../src/views/sessions/sidebar.ts");

beforeEach(() => invoke.mockClear());

const listCall = () => invoke.mock.calls.find((c) => c[0] === "list_instances");

describe("refreshSessions", () => {
  it("is a background read by default", async () => {
    await refreshSessions();
    expect(listCall()[2]).toEqual({ background: true });
  });

  it("the first load of the list is not", async () => {
    await refreshSessions(false);
    expect(listCall()[2]).toEqual({ background: false });
  });
});
