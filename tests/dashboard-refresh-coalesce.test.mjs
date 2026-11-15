// @vitest-environment jsdom
// asserts: src/views/dashboard/dashboard.ts

// pc-1748: one usage update reaches the home dashboard twice (boot.ts's listener
// calls refreshDashboardView, and renderDashboard listens itself). Each used to
// tear every widget down and rebuild the whole dashboard, so its charts were drawn
// twice per update. Requests close together share one rebuild; one that lands while
// a refresh is fetching gets its own, since that fetch may predate the news.

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

const { renderDashboard, refreshDashboardView } = await import("../src/views/dashboard/dashboard.ts");

const personal = { id: "acct-sub", label: "Personal", icon: "user", colour: "#9d7dfc", kind: "subscription" };
const settle = () => new Promise((r) => setTimeout(r, 150));

beforeEach(() => {
  document.body.innerHTML = "";
  apiMock.listAccounts.mockReset();
  apiMock.listAccounts.mockResolvedValue([personal]);
  apiMock.onHistoryUpdated.mockClear();
});

describe("home dashboard refresh", () => {
  it("one usage update that reaches it twice rebuilds the dashboard once", async () => {
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = await renderDashboard(root);
    await vi.waitFor(() => expect(root.querySelector(".dash-acard")).not.toBeNull());
    await settle();
    const before = apiMock.listAccounts.mock.calls.length;
    const cards = root.querySelector(".dash-acard");

    // What boot.ts and the view's own listener each do on the same `usage-updated`.
    const own = apiMock.onHistoryUpdated.mock.calls.at(-1)[0];
    own([]);
    refreshDashboardView();
    await settle();

    expect(apiMock.listAccounts.mock.calls.length - before).toBe(1);
    expect(root.querySelector(".dash-acard")).not.toBe(cards);

    // A later update still refreshes.
    refreshDashboardView();
    await settle();
    expect(apiMock.listAccounts.mock.calls.length - before).toBe(2);
    dispose();
  });

  it("a refresh queued behind a running one does not run once the dashboard was left", async () => {
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = await renderDashboard(root);
    await vi.waitFor(() => expect(root.querySelector(".dash-acard")).not.toBeNull());
    await settle();
    const before = apiMock.listAccounts.mock.calls.length;

    let release;
    apiMock.listAccounts.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve([personal]); }));
    refreshDashboardView();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    refreshDashboardView();
    dispose();
    release();
    await settle();
    expect(apiMock.listAccounts.mock.calls.length - before).toBe(1);
  });

  it("a request that lands while a refresh is fetching gets a refresh of its own, so its news is not lost", async () => {
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = await renderDashboard(root);
    await vi.waitFor(() => expect(root.querySelector(".dash-acard")).not.toBeNull());
    await settle();
    const before = apiMock.listAccounts.mock.calls.length;

    // The first refresh's account read is held open, like a slow daemon.
    let release;
    apiMock.listAccounts.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve([personal]); }));
    refreshDashboardView();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    // Fresh usage arrives while that read is out: its answer predates it.
    refreshDashboardView();
    release();
    await settle();
    expect(apiMock.listAccounts.mock.calls.length - before).toBe(2);
    dispose();
  });
});
