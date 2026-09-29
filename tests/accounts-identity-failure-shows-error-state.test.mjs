// @vitest-environment jsdom
//
// Todo 1017, caller-change half: accounts.ts's refreshList already wraps its
// listAccounts/getSettings/getAccountIdentity reads in one try/catch that
// renders the inline "Couldn't load accounts" error card, but that catch was
// unreachable for an identity failure because getAccountIdentity used to
// swallow a failed get_account_identity call to null - identical to "no
// identity resolved". Now that it rejects, prove the failure surfaces as the
// error card instead of a silently identity-less row.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));

const { renderAccountsSettingsView } = await import(
  "../src/views/settings/subviews/accounts/accounts.ts"
);

const flush = () => new Promise((r) => setTimeout(r, 0));

const account = {
  id: "a1",
  label: "Main",
  colour: "#fff",
  icon: "x",
  config_dir: "",
  chrome_profile_dir: "",
  email: "a@x.com",
  org_uuid: "org1",
  subscription_tier: "pro",
};

beforeEach(() => {
  invokeMock.mockReset();
  document.body.innerHTML = "";
});

describe("accounts settings - a failed identity read shows the error state", () => {
  it("shows the couldn't-load error card when get_account_identity rejects", async () => {
    invokeMock.mockImplementation((command) => {
      if (command === "list_accounts") return Promise.resolve([account]);
      if (command === "get_settings") return Promise.resolve({});
      if (command === "get_account_identity") return Promise.reject(new Error("backend unreachable"));
      if (command === "get_terminal_identity") return Promise.resolve(null);
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    const root = document.createElement("div");
    document.body.appendChild(root);
    await renderAccountsSettingsView(root);
    await flush();
    await flush();

    expect(root.innerHTML).toContain("Couldn't load accounts");
    expect(root.innerHTML).not.toContain("Main");
  });

  it("still renders the account row when get_account_identity succeeds", async () => {
    invokeMock.mockImplementation((command) => {
      if (command === "list_accounts") return Promise.resolve([account]);
      if (command === "get_settings") return Promise.resolve({});
      if (command === "get_account_identity") return Promise.resolve(null);
      if (command === "get_terminal_identity") return Promise.resolve(null);
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    const root = document.createElement("div");
    document.body.appendChild(root);
    await renderAccountsSettingsView(root);
    await flush();
    await flush();

    expect(root.innerHTML).toContain("Main");
    expect(root.innerHTML).not.toContain("Couldn't load accounts");
  });
});
