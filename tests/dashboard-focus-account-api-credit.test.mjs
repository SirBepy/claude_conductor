// @vitest-environment jsdom

// focusDashboardAccount is the overlay card click's target. The overlay never
// draws the API-credit account, but a stale or hand-sent id must not select it
// on the dashboard, which has no plan usage card for it.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    listAccounts: vi.fn(),
    getUsageMap: vi.fn(async () => ({})),
    getAuthStateMap: vi.fn(async () => ({})),
    getSettings: vi.fn(async () => ({})),
    getApiCreditStatus: vi.fn(async () => null),
    onApiCreditStatusChanged: vi.fn(() => () => {}),
    onHistoryUpdated: vi.fn(() => () => {}),
    onInstancesChanged: vi.fn(() => () => {}),
    listInstances: vi.fn(async () => []),
    getUsageHistory: vi.fn(async () => []),
    getAccountsSetupPromptState: vi.fn(async () => ({ shouldShow: false })),
  },
}));
vi.mock("../src/shared/api.ts", () => ({ api: new Proxy(apiMock, { get: (t, k) => t[k] ?? vi.fn(async () => null) }) }));
vi.mock("../src/shared/token-history.ts", () => ({
  loadTokenHistory: async () => [],
  mergeLiveSessions: () => [],
}));

// jsdom has no CSS.escape, which the dashboard's widget lookup uses.
globalThis.CSS ??= {};
globalThis.CSS.escape ??= (s) => String(s);

const { renderDashboard, focusDashboardAccount } = await import("../src/views/dashboard/dashboard.ts");
const { setCachedAccounts } = await import("../src/shared/accounts-cache.ts");

const sub = { id: "acct-sub", label: "Personal", icon: "user", colour: "#9d7dfc", kind: "subscription" };
const work = { id: "acct-work", label: "Work", icon: "briefcase", colour: "#f5a623", kind: "subscription" };
const credit = { id: "acct-credit", label: "API credit", icon: "key", colour: "#10b981", kind: "api_credit" };

beforeEach(() => {
  document.body.innerHTML = "";
  apiMock.listAccounts.mockResolvedValue([sub, work, credit]);
});

async function mountAndGetActive() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const dispose = await renderDashboard(root);
  await vi.waitFor(() => expect(root.querySelector(".dash-acard")).not.toBeNull());
  const active = Array.from(root.querySelectorAll(".dash-acard.active")).map((c) => c.dataset.accId);
  dispose();
  return active;
}

describe("focusDashboardAccount", () => {
  it("selects a plan account asked for before the dashboard mounts", async () => {
    setCachedAccounts([sub, work, credit]);
    focusDashboardAccount("acct-work");
    expect(await mountAndGetActive()).toEqual(["acct-work"]);
  });

  it("ignores the API-credit account's id", async () => {
    setCachedAccounts([sub, work, credit]);
    focusDashboardAccount("acct-credit");
    const active = await mountAndGetActive();
    expect(active).not.toContain("acct-credit");
    expect(active).toHaveLength(1);
  });
});
