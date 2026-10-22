// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

// The phone's new-chat flow reads one bundled response (cached in
// localStorage) instead of one request per project per field, so a tap opens
// the next modal from cache instead of queueing behind the tunnel.

const remote = { value: true };
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => remote.value }));
const invoke = vi.fn();
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invoke(...a) }));
vi.mock("../src/shared/api.ts", () => ({
  api: {
    listProjects: () => invoke("list_projects"),
    listAccounts: () => invoke("list_accounts"),
    resolveProjectAccount: (cwd) => invoke("resolve_project_account", { cwd }),
    resolveWhitelistCharacters: () => Promise.resolve([]),
  },
}));

const cache = await import("../src/views/sessions/new-session-cache.ts");

const BUNDLE = {
  groups: [{ path: "C:\\p\\one", name: "one", worktrees: [], path_exists: true }],
  stats: { "C:\\p\\one": { mtime: 42, todoCount: 3 } },
  scopes: { "C:\\p\\one": [{ rel_path: "", abs_path: "C:\\p\\one", label: "Repo root", nested: false }] },
  projectAccounts: { "C:\\p\\one": "acct-1" },
  projects: [{ id: "x", path: "C:\\p\\one" }],
  settings: { default_account_id: "acct-1" },
  accounts: [{ id: "acct-1" }],
};

const methods = () => invoke.mock.calls.map((c) => c[0]);

beforeEach(() => {
  remote.value = true;
  localStorage.clear();
  cache.resetNewSessionCacheForTests();
  invoke.mockReset();
  invoke.mockImplementation((m) => (m === "new_session_bundle" ? Promise.resolve(BUNDLE) : Promise.resolve(null)));
});

describe("phone new-session bundle", () => {
  it("warms every entry from one request and persists it", async () => {
    cache.warmNewSessionCache();
    await cache.refreshNewSessionBundle();
    expect(methods()).toEqual(["new_session_bundle"]);
    expect(cache.projectGroupsData().cached?.[0].name).toBe("one");
    expect(cache.cachedProjectStat("C:\\p\\one")).toEqual({ mtime: 42, todoCount: 3 });
    expect(cache.claudeMdScopesData("C:\\p\\one").cached).toHaveLength(1);
    expect(cache.projectAccountData("C:\\p\\one").cached).toBe("acct-1");
    expect(cache.settingsData().cached).toEqual({ default_account_id: "acct-1" });
    expect(JSON.parse(localStorage.getItem(cache.BUNDLE_STORAGE_KEY)).groups).toHaveLength(1);
  });

  it("paints from the stored bundle after a reload, before the network answers", () => {
    localStorage.setItem(cache.BUNDLE_STORAGE_KEY, JSON.stringify(BUNDLE));
    invoke.mockImplementation(() => new Promise(() => {}));
    expect(cache.projectGroupsData().cached?.[0].path).toBe("C:\\p\\one");
    expect(cache.claudeMdScopesData("C:\\p\\one").cached).toHaveLength(1);
  });

  it("revalidates cached entries through the bundle, never per field", async () => {
    localStorage.setItem(cache.BUNDLE_STORAGE_KEY, JSON.stringify(BUNDLE));
    await Promise.all([
      cache.projectGroupsData().ready,
      cache.projectStatData("C:\\p\\one").ready,
      cache.claudeMdScopesData("C:\\p\\one").ready,
      cache.projectAccountData("C:\\p\\one").ready,
      cache.settingsData().ready,
    ]);
    expect(methods()).toEqual(["new_session_bundle"]);
  });

  it("a read right after a bundle lands reuses it instead of re-scanning", async () => {
    await cache.refreshNewSessionBundle();
    await cache.projectStatData("C:\\p\\one").ready;
    expect(methods().filter((m) => m === "new_session_bundle")).toHaveLength(1);
  });

  it("never fans out per-project stat requests, even cold", async () => {
    await cache.projectStatData("C:\\p\\one").ready;
    expect(methods()).not.toContain("count_ai_todos");
    expect(methods()).not.toContain("project_last_activity_at");
  });
});
