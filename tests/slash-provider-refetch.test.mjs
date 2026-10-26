// The slash menu re-reads its list each time a fresh "/" opens it, since
// /pickup's presence follows the project's PLAN.md, which no watcher reports.

import { describe, it, expect, vi } from "vitest";

const lists = [
  [{ name: "handoff", args: null, description: "", source: { kind: "user-skill" }, path: null }],
  [
    { name: "handoff", args: null, description: "", source: { kind: "user-skill" }, path: null },
    { name: "pickup", args: null, description: "", source: { kind: "user-skill" }, path: null },
  ],
];
const invoke = vi.fn(async () => lists[Math.min(invoke.mock.calls.length - 1, lists.length - 1)]);
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invoke(...a) }));
vi.mock("../src/shared/transport.ts", () => ({ getTransport: () => ({ listen: async () => () => {} }) }));

const { SlashProvider } = await import("../src/shared/chat/caret-popup/providers/slash.ts");

describe("SlashProvider", () => {
  it("refetches on a bare '/' so a newly pickable PLAN.md shows /pickup", async () => {
    const p = new SlashProvider();
    await p.start("C:/w/app");
    expect(p.query("/pi").map((e) => e.name)).not.toContain("pickup");
    expect(invoke).toHaveBeenCalledTimes(1);

    p.query("/");
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith("list_slash_commands", { projectDir: "C:/w/app" });
    await vi.waitFor(() => expect(p.query("/pi").map((e) => e.name)).toContain("pickup"));
    // Narrowing the query does not refetch again.
    expect(invoke).toHaveBeenCalledTimes(2);
    p.stop();
  });
});
