import { describe, it, expect } from "vitest";
import { resolveInitialAccountId } from "../src/views/sessions/account-picker-logic.ts";

const personal = { id: "acct-personal", label: "Personal", icon: "user", colour: "#9d7dfc" };
const work = { id: "acct-work", label: "Work", icon: "briefcase", colour: "#f5a623" };
const fibo = { id: "acct-fibo", label: "Fibo", icon: "palette", colour: "#3ecf8e" };

describe("resolveInitialAccountId", () => {
  it("returns null when the registry is empty", () => {
    expect(resolveInitialAccountId(null, null, [])).toBeNull();
    expect(resolveInitialAccountId("acct-work", "acct-work", [])).toBeNull();
  });

  it("prefers the project's bound account over the default", () => {
    expect(resolveInitialAccountId("acct-work", "acct-personal", [personal, work, fibo])).toBe(
      "acct-work",
    );
  });

  it("falls back to the default account when there is no binding", () => {
    expect(resolveInitialAccountId(null, "acct-fibo", [personal, work, fibo])).toBe("acct-fibo");
  });

  it("ignores a binding that points at a removed account", () => {
    expect(resolveInitialAccountId("acct-deleted", "acct-work", [personal, work])).toBe(
      "acct-work",
    );
  });

  it("ignores a default that points at a removed account, falling back further", () => {
    // No binding, default is stale, but exactly one account remains.
    expect(resolveInitialAccountId(null, "acct-deleted", [personal])).toBe("acct-personal");
  });

  it("falls back to the sole account when neither binding nor default is set", () => {
    expect(resolveInitialAccountId(null, null, [work])).toBe("acct-work");
  });

  it("returns null when nothing resolves and multiple accounts exist", () => {
    expect(resolveInitialAccountId(null, null, [personal, work])).toBeNull();
    expect(resolveInitialAccountId("acct-deleted", "acct-also-deleted", [personal, work])).toBeNull();
  });
});

// An API-credit chat spends the Max plan's monthly API credit, so none of the
// three automatic picks may ever land on one.
describe("resolveInitialAccountId - API-credit accounts are never preselected", () => {
  const credit = { id: "acct-credit", label: "API credit", icon: "key", colour: "#10b981", kind: "api_credit" };
  const sub = { ...personal, kind: "subscription" };

  it("ignores a project binding that points at an API-credit account", () => {
    expect(resolveInitialAccountId("acct-credit", null, [sub, work, credit])).toBeNull();
    expect(resolveInitialAccountId("acct-credit", "acct-work", [sub, work, credit])).toBe("acct-work");
  });

  it("ignores a global default that points at an API-credit account", () => {
    expect(resolveInitialAccountId(null, "acct-credit", [sub, work, credit])).toBeNull();
    expect(resolveInitialAccountId(null, "acct-credit", [sub, credit])).toBe("acct-personal");
  });

  it("never takes an API-credit account as the sole-account fallback", () => {
    expect(resolveInitialAccountId(null, null, [credit])).toBeNull();
    // A lone API-credit account still gates the picker even when it is bound AND the default.
    expect(resolveInitialAccountId("acct-credit", "acct-credit", [credit])).toBeNull();
  });

  it("still auto-picks the one subscription account beside an API-credit one", () => {
    expect(resolveInitialAccountId(null, null, [sub, credit])).toBe("acct-personal");
  });

  it("forces an explicit pick when two subscription accounts sit beside an API-credit one", () => {
    expect(resolveInitialAccountId(null, null, [sub, work, credit])).toBeNull();
  });

  it("treats an account with no kind (older daemon or peer) as a subscription", () => {
    expect(resolveInitialAccountId(null, null, [work])).toBe("acct-work");
  });
});

// A paired machine's list_machine_accounts answer feeds the same resolver:
// its api_credit accounts (the host now sends `kind`) are never preselected,
// even as the host's own project binding or default.
describe("resolveInitialAccountId - a peer machine's API-credit account", () => {
  const peerSub = { id: "win-1", label: "Work", icon: "briefcase", colour: "#abc", email: "w@x.test", kind: "subscription" };
  const peerCredit = { id: "win-2", label: "Credit", icon: "key", colour: "#10b981", email: "c@x.test", kind: "api_credit" };

  it("does not preselect it as the host's binding, default or sole account", () => {
    expect(resolveInitialAccountId("win-2", null, [peerSub, peerCredit])).toBe("win-1");
    expect(resolveInitialAccountId(null, "win-2", [peerCredit])).toBeNull();
    expect(resolveInitialAccountId(null, null, [peerCredit])).toBeNull();
  });
});
