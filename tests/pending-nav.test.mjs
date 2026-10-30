// The Chats window drains a navigation that was queued while it was still being
// built (take_pending_nav). Each target the drain understands must land on the
// same navigation its live `navigate-to-*` event performs; anything else is dropped.

import { describe, it, expect, vi } from "vitest";

const { applyPendingNav } = await import("../src/boot/pending-nav.ts");

function deps() {
  const calls = [];
  return {
    calls,
    navigateTo: vi.fn(async (view) => { calls.push(`go:${view}`); }),
    focusAccount: vi.fn(async (id) => { calls.push(`focus:${id}`); }),
  };
}

describe("applyPendingNav", () => {
  it("routes dashboard and settings-accounts straight to navigateTo", async () => {
    for (const target of ["dashboard", "settings-accounts"]) {
      const d = deps();
      await applyPendingNav(target, d);
      expect(d.calls, target).toEqual([`go:${target}`]);
      expect(d.focusAccount).not.toHaveBeenCalled();
    }
  });

  it("focuses the account first, then shows the dashboard", async () => {
    const d = deps();
    await applyPendingNav("account:acct-42", d);
    expect(d.calls).toEqual(["focus:acct-42", "go:dashboard"]);
  });

  it("keeps everything after the first colon as the account id", async () => {
    const d = deps();
    await applyPendingNav("account:a:b", d);
    expect(d.focusAccount).toHaveBeenCalledWith("a:b");
  });

  it("drops an unknown target", async () => {
    for (const target of ["history", "account", "Dashboard", "dashboard "]) {
      const d = deps();
      await applyPendingNav(target, d);
      expect(d.calls, target).toEqual([]);
    }
  });

  it("does nothing for an empty drain", async () => {
    for (const nav of [null, undefined, ""]) {
      const d = deps();
      await applyPendingNav(nav, d);
      expect(d.calls, String(nav)).toEqual([]);
    }
  });
});
