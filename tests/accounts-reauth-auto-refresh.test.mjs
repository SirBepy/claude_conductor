// @vitest-environment jsdom
//
// Regression test for the "logged in on the dane account and it didn't
// refresh the UI, I had to leave the page and come back" bug: Reauth used to
// spawn the /login terminal and just tell the user to reopen the screen -
// nothing polled for completion. accounts.ts now polls getAccountIdentity()
// after a Reauth click and auto-refreshes the list once the account's token
// is replaced, with no manual navigation required.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));

const { renderAccountsSettingsView } = await import(
  "../src/views/settings/subviews/accounts/accounts.ts"
);

// Fake timers are active for this suite, so a real setTimeout(0) would never
// fire on its own - advancing the fake clock by 0ms still flushes pending
// microtasks/timers the same way.
const flush = () => vi.advanceTimersByTimeAsync(0);

const account = {
  id: "a1",
  label: "dane",
  colour: "#fff",
  icon: "bell",
  config_dir: "",
  chrome_profile_dir: "",
  email: "bepys.assistant@gmail.com",
  org_uuid: "org1",
  subscription_tier: "Max",
};

beforeEach(() => {
  invokeMock.mockReset();
  document.body.innerHTML = "";
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("accounts settings - Reauth auto-refreshes once /login completes", () => {
  it("re-fetches the account list on its own, with no manual reopen", async () => {
    let identityCalls = 0;
    let listCalls = 0;
    invokeMock.mockImplementation((command) => {
      if (command === "list_accounts") {
        listCalls += 1;
        return Promise.resolve([account]);
      }
      if (command === "get_settings") return Promise.resolve({});
      if (command === "get_account_identity") {
        identityCalls += 1;
        // Stale token for every call up to and including the Reauth click's
        // own "before" snapshot; a fresh one (as /login would produce) from
        // the 3rd call on, simulating the terminal login finishing between
        // poll ticks.
        const tokenExpiresAt = identityCalls <= 2 ? 100 : 200;
        return Promise.resolve({
          oauthAccount: { emailAddress: account.email, organizationUuid: "org1", organizationName: null, organizationType: null },
          tokenExpiresAt,
          refreshTokenExpiresAt: null,
          hasCookie: true,
          drift: false,
          driftMessage: null,
        });
      }
      if (command === "get_terminal_identity") return Promise.resolve(null);
      if (command === "reauth_account") return Promise.resolve(null);
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    const root = document.createElement("div");
    document.body.appendChild(root);
    await renderAccountsSettingsView(root);
    await flush();
    await flush();

    const listCallsBeforeReauth = listCalls;

    root.querySelector(".acc-menu-reauth").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await flush();
    await flush();

    // Poller is armed but hasn't ticked yet - no extra refresh so far.
    expect(listCalls).toBe(listCallsBeforeReauth);

    // Advance past one poll interval; the identity call it makes now returns
    // the fresh token, which should trigger an automatic refreshList().
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    await flush();

    expect(listCalls).toBeGreaterThan(listCallsBeforeReauth);
  });
});
