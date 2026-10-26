// The slash menu re-reads its list each time a fresh "/" opens it, since
// /pickup's presence follows the project's PLAN.md, which no watcher reports.
// A hidden /pickup stays known to the chat's mention lookup, and a failed or
// out-of-order refetch never replaces a good list.

import { describe, it, expect, vi, beforeEach } from "vitest";

const entry = (name, menu_hidden = false) => ({ name, args: null, description: "", source: { kind: "user-skill" }, path: null, menu_hidden });
let replies = [];
const invoke = vi.fn(() => replies.shift()());
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invoke(...a) }));
vi.mock("../src/shared/transport.ts", () => ({ getTransport: () => ({ listen: async () => () => {} }) }));

const { SlashProvider } = await import("../src/shared/chat/caret-popup/providers/slash.ts");
const { lookupSlash } = await import("../src/shared/chat/slash-registry.ts");

const names = (p, q) => p.query(q).map((e) => e.name);

beforeEach(() => { invoke.mockClear(); replies = []; });

describe("SlashProvider", () => {
  it("refetches on a bare '/' so a newly pickable PLAN.md shows /pickup", async () => {
    replies = [async () => [entry("handoff"), entry("pickup", true)], async () => [entry("handoff"), entry("pickup")]];
    const p = new SlashProvider();
    await p.start("C:/w/app");
    expect(names(p, "/pi")).not.toContain("pickup");
    // Hidden from the popup, still a known command for highlighting a mention.
    expect(lookupSlash("pickup")).not.toBeNull();

    p.query("/");
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith("list_slash_commands", { projectDir: "C:/w/app" });
    await vi.waitFor(() => expect(names(p, "/pi")).toContain("pickup"));
    // Narrowing the query does not refetch again.
    expect(invoke).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it("a failed refetch keeps the list it had", async () => {
    replies = [async () => [entry("handoff")], async () => { throw new Error("daemon busy"); }];
    vi.spyOn(console, "error").mockImplementation(() => {});
    const p = new SlashProvider();
    await p.start("C:/w/app");
    p.query("/");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(names(p, "/ha")).toEqual(["handoff"]);
    p.stop();
  });

  it("an older reply landing after a newer one is dropped", async () => {
    let releaseOld;
    replies = [
      async () => [entry("handoff")],
      () => new Promise((r) => { releaseOld = () => r([entry("stale")]); }),
      async () => [entry("fresh")],
    ];
    const p = new SlashProvider();
    await p.start("C:/w/app");
    p.query("/");
    p.query("/");
    await vi.waitFor(() => expect(names(p, "/fr")).toEqual(["fresh"]));
    releaseOld();
    await new Promise((r) => setTimeout(r, 0));
    expect(names(p, "/st")).toEqual([]);
    expect(names(p, "/fr")).toEqual(["fresh"]);
    p.stop();
  });
});
