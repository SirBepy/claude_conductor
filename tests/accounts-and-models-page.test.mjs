// @vitest-environment jsdom
// asserts: src/views/settings/subviews/accounts/accounts.ts, src/views/settings/subviews/accounts/company-sections.ts, src/views/settings/subviews/models-providers/who-does-what.ts

// Settings > Accounts & models: one page, two tabs (Accounts | Who does what),
// the Accounts tab a section per company with three billing labels, an empty
// company a dashed Add row, the phone with the Anthropic section only. API keys
// are NOT on this page (they have their own, see settings-system-split.test.mjs).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { apiMock, flowMock, modalMock } = vi.hoisted(() => ({
  apiMock: {
    listAccounts: vi.fn(),
    getSettings: vi.fn(),
    getAccountIdentity: vi.fn(),
    getAuthStateMap: vi.fn(),
    getTerminalIdentity: vi.fn(),
    getApiCreditStatus: vi.fn(),
    onApiCreditStatusChanged: vi.fn(),
    listProjects: vi.fn(),
    removeAccount: vi.fn(),
  },
  flowMock: { openAddAccountFlow: vi.fn() },
  modalMock: { openAddEndpointModal: vi.fn(), openEditEndpointModal: vi.fn(), openReplaceEndpointKeyModal: vi.fn() },
}));
vi.mock("../src/shared/api.ts", () => ({ api: apiMock }));
vi.mock("../src/shared/state.ts", () => ({ getSettings: () => ({}), setSettings: vi.fn() }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: vi.fn() }));
vi.mock("../src/views/settings/subviews/accounts/add-account-flow.ts", () => flowMock);
vi.mock("../src/views/settings/subviews/models-providers/provider-modals.ts", () => modalMock);

let remote = false;
vi.mock("../src/shared/transport.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isRemote: () => remote };
});

const { renderAccountsSettingsView } = await import("../src/views/settings/subviews/accounts/accounts.ts");
const { requestGroupTab } = await import("../src/shared/routing-rules.ts");
const sections = await import("../src/views/settings/subviews/accounts/company-sections.ts");

const PLAN = { id: "p1", label: "Work Max", icon: "briefcase", colour: "#d97757", kind: "subscription", email: "joe@work.example", subscription_tier: "claude_max", config_dir: "", chrome_profile_dir: "", org_uuid: "" };
const CREDIT = { id: "c1", label: "Max API credit", icon: "key", colour: "#10b981", kind: "api_credit", email: "joe@work.example", subscription_tier: "", config_dir: "", chrome_profile_dir: "", org_uuid: "" };
const endpoint = (id, label, preset) => ({ id, label, icon: "key", colour: "#fff", kind: "endpoint", email: "", subscription_tier: "", config_dir: "", chrome_profile_dir: "", org_uuid: "", endpoint: { preset, base_url: `https://${preset}.example/api`, auth_style: "bearer", models: [] } });
const KIMI = endpoint("k1", "Kimi personal", "kimi_code");
const DEEPSEEK = endpoint("d1", "DeepSeek work key", "deepseek");

// jsdom has no ResizeObserver; the tab only needs it to exist.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

async function mount(accounts, terminal = null) {
  apiMock.listAccounts.mockResolvedValue(accounts);
  apiMock.getTerminalIdentity.mockResolvedValue(terminal);
  const root = document.createElement("div");
  document.body.appendChild(root);
  const dispose = await renderAccountsSettingsView(root);
  await flush();
  return { root, dispose };
}

const chips = (el) => [...el.querySelectorAll(".mp-badge")].map((b) => b.textContent);
const company = (root, id) => root.querySelector(`.acm-prov[data-company="${id}"]`);

beforeEach(() => {
  remote = false;
  document.body.innerHTML = "";
  for (const m of Object.values(apiMock)) m.mockReset();
  for (const m of [...Object.values(flowMock), ...Object.values(modalMock)]) m.mockReset();
  apiMock.getSettings.mockResolvedValue({ routing: { groups: {} } });
  apiMock.getAccountIdentity.mockResolvedValue(null);
  apiMock.getAuthStateMap.mockResolvedValue({});
  apiMock.getApiCreditStatus.mockResolvedValue({});
  apiMock.onApiCreditStatusChanged.mockReturnValue(() => {});
  apiMock.listProjects.mockResolvedValue([{ name: "app", payment_group: "personal" }, { name: "client-app", payment_group: "client" }]);
});

describe("Accounts tab", () => {
  it("is a section per company, Anthropic holding plan and API-credit rows", async () => {
    const { root, dispose } = await mount([PLAN, CREDIT, KIMI, DEEPSEEK]);
    expect([...root.querySelectorAll(".acm-prov[data-company]")].map((s) => s.dataset.company)).toEqual(["anthropic", "kimi_code", "deepseek", "openrouter", "custom"]);
    expect([...company(root, "anthropic").querySelectorAll(".acc-row[data-id]")].map((r) => r.dataset.id)).toEqual(["p1", "c1"]);
    expect([...company(root, "kimi_code").querySelectorAll(".acc-row[data-id]")].map((r) => r.dataset.id)).toEqual(["k1"]);
    expect([...company(root, "deepseek").querySelectorAll(".acc-row[data-id]")].map((r) => r.dataset.id)).toEqual(["d1"]);
    expect(root.querySelector(".mp-later")?.textContent).toContain("coming later");
    dispose();
  });

  it("uses one billing label per row, three labels in all, never Membership", async () => {
    const { root, dispose } = await mount([PLAN, CREDIT, KIMI, DEEPSEEK]);
    expect(chips(company(root, "anthropic").querySelector('[data-id="p1"]'))).toEqual(["Subscription"]);
    expect(chips(company(root, "anthropic").querySelector('[data-id="c1"]'))).toEqual(["Included credit"]);
    expect(chips(company(root, "kimi_code"))).toEqual(["Subscription"]);
    expect(chips(company(root, "deepseek"))).toEqual(["Pay per token"]);
    expect(new Set(chips(root.querySelector(".acm-legend")))).toEqual(new Set(["Subscription", "Included credit", "Pay per token"]));
    expect(root.textContent).not.toContain("Membership");
    dispose();
  });

  it("draws a company with no account as a dashed Add row, and one with accounts as a small Add button", async () => {
    const { root, dispose } = await mount([PLAN, DEEPSEEK]);
    expect(company(root, "anthropic").querySelector(".acm-add")).not.toBeNull();
    expect(company(root, "anthropic").querySelector(".acm-add-row")).toBeNull();
    expect(company(root, "deepseek").querySelector(".acm-add")?.textContent).toContain("Add DeepSeek");
    for (const empty of ["kimi_code", "openrouter", "custom"]) {
      const sec = company(root, empty);
      expect(sec.querySelector(".acm-add-row")?.dataset.add).toBe(empty);
      expect(sec.querySelector(".acm-add")).toBeNull();
    }
    dispose();
  });

  it("shows the Terminal row always and never counts it as an Anthropic account", async () => {
    const { root, dispose } = await mount([], { emailAddress: "joe@home.example", organizationName: null });
    const anthropic = company(root, "anthropic");
    expect(anthropic.querySelector(".acm-add-row")?.dataset.add).toBe("anthropic");
    expect(anthropic.querySelector(".acm-add")).toBeNull();
    const term = anthropic.querySelector("#acc-terminal-identity");
    expect(term?.textContent).toContain("joe@home.example");
    expect(root.querySelector("#acm-cnt-accounts").textContent).toBe("0");
    dispose();
  });

  it("keeps the Terminal row through a list refresh", async () => {
    const { root, dispose } = await mount([PLAN], { emailAddress: "joe@work.example", organizationName: null });
    // The add flow resolves with an account, so the page re-reads the list.
    modalMock.openAddEndpointModal.mockResolvedValue({ id: "k1" });
    apiMock.listAccounts.mockResolvedValue([PLAN, KIMI]);
    company(root, "kimi_code").querySelector("[data-add]").click();
    await flush();
    await flush();
    expect(company(root, "kimi_code").querySelector('[data-id="k1"]')).not.toBeNull();
    expect(root.querySelector("#acc-terminal-identity").textContent).toContain("joe@work.example");
    dispose();
  });

  it("opens Anthropic's kind card from its Add and a provider's own form from its Add", async () => {
    flowMock.openAddAccountFlow.mockResolvedValue(null);
    modalMock.openAddEndpointModal.mockResolvedValue(null);
    const { root, dispose } = await mount([PLAN]);
    company(root, "anthropic").querySelector("[data-add]").click();
    await flush();
    expect(flowMock.openAddAccountFlow).toHaveBeenCalledTimes(1);
    company(root, "openrouter").querySelector("[data-add]").click();
    await flush();
    expect(modalMock.openAddEndpointModal).toHaveBeenCalledWith("openrouter");
    dispose();
  });

  it("routes an Endpoint row's menu to its own Edit modal", async () => {
    modalMock.openEditEndpointModal.mockResolvedValue(null);
    const { root, dispose } = await mount([DEEPSEEK]);
    const row = company(root, "deepseek").querySelector('[data-id="d1"]');
    expect([...row.querySelectorAll(".menu-item")].map((i) => i.textContent.trim())).toEqual(["Edit", "Replace API key", "Remove"]);
    row.querySelector('[data-act="edit"]').click();
    await flush();
    expect(modalMock.openEditEndpointModal).toHaveBeenCalledWith(expect.objectContaining({ id: "d1" }));
    dispose();
  });

  it("gives an Endpoint account none of the plan actions", async () => {
    const { root, dispose } = await mount([PLAN, KIMI]);
    expect(apiMock.getAccountIdentity).toHaveBeenCalledTimes(1);
    expect(apiMock.getAccountIdentity).toHaveBeenCalledWith("p1");
    expect(company(root, "kimi_code").querySelector(".acc-menu-reauth")).toBeNull();
    dispose();
  });
});

describe("page frame", () => {
  it("has two tabs, no API keys tab or list, and no info button in the header", async () => {
    const { root, dispose } = await mount([PLAN]);
    expect([...root.querySelectorAll(".acm-tab")].map((t) => t.textContent.trim().replace(/\s+\d*$/, ""))).toEqual(["Accounts", "Who does what"]);
    expect(root.querySelector("#apiKeysList")).toBeNull();
    expect(root.querySelector("#apiKeysSection")).toBeNull();
    expect(root.querySelector(".view-header h2").textContent).toBe("Accounts & models");
    expect(root.querySelector(".view-header .ph-info")).toBeNull();
    expect(root.querySelector(".mp-tipbtn")).toBeNull();
    dispose();
  });

  it("keeps the page classes the project rail popup and the popup spec rely on", async () => {
    const { root, dispose } = await mount([PLAN]);
    expect(root.querySelector(".view.view-settings-accounts.view-settings-models-providers")).not.toBeNull();
    dispose();
  });

  it("loads Who does what only once its tab opens", async () => {
    const { root, dispose } = await mount([PLAN]);
    expect(apiMock.listProjects).not.toHaveBeenCalled();
    expect(root.querySelector("#acm-panel-who").hidden).toBe(true);
    root.querySelector("#acm-tab-who").click();
    await vi.waitFor(() => expect(root.querySelector("#mp-cards-personal .mp-card")).not.toBeNull());
    expect(root.querySelector("#acm-panel-who").hidden).toBe(false);
    expect(root.querySelector("#acm-panel-accounts").hidden).toBe(true);
    expect(root.querySelector("#acm-tab-who").getAttribute("aria-selected")).toBe("true");
    expect(root.querySelector("#mp-proj-client").textContent).toContain("client-app");
    dispose();
  });

  it("opens on Who does what, on the asked group, when a project's rail links there", async () => {
    requestGroupTab("client");
    const { root, dispose } = await mount([PLAN]);
    await vi.waitFor(() => expect(root.querySelector("#mp-cards-client .mp-card")).not.toBeNull());
    expect(root.querySelector("#acm-tab-who").classList.contains("on")).toBe(true);
    expect(root.querySelector("#mp-tab-client").getAttribute("aria-selected")).toBe("true");
    dispose();
  });
});

describe("on the phone", () => {
  it("keeps only the Anthropic section: no tabs, no provider sections, no Codex row, no Endpoint rows", async () => {
    remote = true;
    const { root, dispose } = await mount([PLAN, CREDIT, KIMI]);
    expect(root.querySelector("#acm-tabs")).toBeNull();
    expect(root.querySelector("#acm-panel-who")).toBeNull();
    expect(root.querySelector("#mp-sheet")).toBeNull();
    expect([...root.querySelectorAll(".acm-prov[data-company]")].map((s) => s.dataset.company)).toEqual(["anthropic"]);
    expect(root.querySelector(".mp-later")).toBeNull();
    expect(root.querySelector('[data-id="k1"]')).toBeNull();
    expect(new Set(chips(root.querySelector(".acm-legend")))).toEqual(new Set(["Subscription", "Included credit"]));
    dispose();
  });

  it("still offers Anthropic's Add, which goes straight to the sign-in", async () => {
    remote = true;
    flowMock.openAddAccountFlow.mockResolvedValue(null);
    const { root, dispose } = await mount([]);
    root.querySelector('[data-add="anthropic"]').click();
    await flush();
    expect(flowMock.openAddAccountFlow).toHaveBeenCalledTimes(1);
    dispose();
  });
});

describe("company sections markup", () => {
  it("names each Add by its company", () => {
    expect(sections.addLabel("anthropic")).toBe("Add account");
    expect(sections.addLabel("kimi_code")).toBe("Add Kimi Code");
    expect(sections.addLabel("custom")).toBe("Add Custom endpoint");
  });

  it("lists the provider sections in the board's order", () => {
    expect(sections.ENDPOINT_COMPANIES).toEqual(["kimi_code", "deepseek", "openrouter", "custom"]);
  });
});
