// @vitest-environment jsdom
// The phone paints its usage dials from the last-known copy before the tunnel
// answers. A failed fetch must keep that copy on screen, not blank the row.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/shared/api.ts", () => ({
  api: {
    listAccounts: vi.fn(),
    getUsageMap: vi.fn(),
    refreshUsageLive: vi.fn(),
  },
}));

import { api } from "../src/shared/api.ts";
import { mountUsageDials } from "../src/views/sessions/usage-dials.ts";

const account = { id: "acct-1", label: "personal", icon: "user", colour: "#9d7dfc" };

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("usage dials - cache-first paint", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(api.listAccounts).mockReset();
    vi.mocked(api.getUsageMap).mockReset();
  });

  it("keeps the cached dials when the first fetch fails", async () => {
    localStorage.setItem("cc_usage_dials_v1", JSON.stringify({ accounts: [account], usageMap: {} }));
    vi.mocked(api.listAccounts).mockRejectedValue(new Error("tunnel down"));
    vi.mocked(api.getUsageMap).mockRejectedValue(new Error("tunnel down"));
    const host = document.createElement("div");
    host.hidden = true;
    const teardown = mountUsageDials(host);
    await flush();
    expect(host.hidden).toBe(false);
    expect(host.querySelector("[data-acc-id='acct-1']")).not.toBeNull();
    teardown();
  });

  it("stays hidden when the fetch fails and nothing was cached", async () => {
    vi.mocked(api.listAccounts).mockRejectedValue(new Error("tunnel down"));
    vi.mocked(api.getUsageMap).mockRejectedValue(new Error("tunnel down"));
    const host = document.createElement("div");
    host.hidden = true;
    const teardown = mountUsageDials(host);
    await flush();
    expect(host.hidden).toBe(true);
    teardown();
  });
});
