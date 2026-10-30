// @vitest-environment jsdom

// The project settings "Account" row picks which account new chats in
// the project use. An API-credit account can never be a project binding (the
// backend refuses it), so it is not an option there.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    listAccounts: vi.fn(),
    listProjects: vi.fn(async () => []),
    getSettings: vi.fn(async () => ({})),
    resolveProjectAccount: vi.fn(async () => null),
    ensureProject: vi.fn(),
    updateProject: vi.fn(),
  },
}));
vi.mock("../src/shared/api.ts", () => ({ api: apiMock }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: vi.fn() }));

const { renderProjectSettings } = await import(
  "../src/views/sessions/project-dashboard/project-config/project-settings.ts"
);

const sub = { id: "acct-sub", label: "Personal", icon: "user", colour: "#9d7dfc", kind: "subscription" };
const work = { id: "acct-work", label: "Work", icon: "briefcase", colour: "#f5a623" };
const credit = { id: "acct-credit", label: "API credit", icon: "key", colour: "#10b981", kind: "api_credit" };

beforeEach(() => {
  apiMock.listAccounts.mockReset();
  document.body.innerHTML = "";
});

async function optionValues(accounts) {
  apiMock.listAccounts.mockResolvedValue(accounts);
  const root = document.createElement("div");
  document.body.appendChild(root);
  await renderProjectSettings(root, "C:/proj");
  return Array.from(root.querySelectorAll("#projectAccountSelect option")).map((o) => o.value);
}

describe("project settings account row", () => {
  it("lists plan accounts but not the API-credit one", async () => {
    expect(await optionValues([sub, credit, work])).toEqual(["", "acct-sub", "acct-work"]);
  });

  it("shows the empty hint instead of a select when only the API-credit account exists", async () => {
    apiMock.listAccounts.mockResolvedValue([credit]);
    const root = document.createElement("div");
    document.body.appendChild(root);
    await renderProjectSettings(root, "C:/proj");
    expect(root.querySelector("#projectAccountSelect")).toBeNull();
    expect(root.querySelector(".acc-row-empty-hint")).not.toBeNull();
  });
});
