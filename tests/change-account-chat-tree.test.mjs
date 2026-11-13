// @vitest-environment jsdom

// One "Change account" moves a main chat and its subs together: the picker
// offers an "Also move its N subchats" switch (on by default), leaves API
// credit out for a chat that cannot run on it, and the move sends one daemon
// call per chat, skipping any already on the picked account.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { listAccounts, moveSessionToAccount } = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  moveSessionToAccount: vi.fn(),
}));
vi.mock("../src/shared/api.ts", () => ({
  api: { listAccounts: (...a) => listAccounts(...a), moveSessionToAccount: (...a) => moveSessionToAccount(...a) },
}));
const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: (...a) => showToast(...a) }));

const { openChangeAccountForChat } = await import("../src/shared/change-account-modal.ts");
const { movableSubs, planAccountMove, moveChatToAccount } = await import("../src/views/sessions/account-move.ts");

const personal = { id: "acct-personal", label: "personal", icon: "user", colour: "#9d7dfc" };
const work = { id: "acct-work", label: "work", icon: "briefcase", colour: "#f5a623" };
const credit = { id: "acct-credit", label: "API credit", icon: "user", colour: "#10b981", kind: "api_credit" };

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function inst(id, account_id, extra = {}) {
  return { session_id: id, account_id, subchat_of: null, ended_at: null, end_reason: null, ...extra };
}

beforeEach(() => {
  listAccounts.mockReset().mockResolvedValue([personal, work, credit]);
  moveSessionToAccount.mockReset().mockImplementation(async (id) => id);
  showToast.mockReset();
});
afterEach(() => { document.body.innerHTML = ""; });

describe("openChangeAccountForChat", () => {
  it("shows the subs switch, on by default, and reports it with the pick", async () => {
    const p = openChangeAccountForChat({ currentId: personal.id, subsCount: 3, apiCreditAllowed: false });
    await flush();
    const input = document.querySelector(".cam-subs-input");
    expect(input).not.toBeNull();
    expect(input.checked).toBe(true);
    expect(document.querySelector(".cam-subs-row").textContent).toContain("Also move its 3 subchats");
    document.querySelector(`[data-acc-id="${work.id}"]`).click();
    expect(await p).toEqual({ id: work.id, withSubs: true });
  });

  it("reports withSubs false once the switch is turned off", async () => {
    const p = openChangeAccountForChat({ currentId: personal.id, subsCount: 1, apiCreditAllowed: false });
    await flush();
    expect(document.querySelector(".cam-subs-row").textContent).toContain("Also move its 1 subchat");
    document.querySelector(".cam-subs-input").click();
    document.querySelector(`[data-acc-id="${work.id}"]`).click();
    expect(await p).toEqual({ id: work.id, withSubs: false });
  });

  it("draws no switch for a chat without subs", async () => {
    const p = openChangeAccountForChat({ currentId: personal.id, subsCount: 0, apiCreditAllowed: true });
    await flush();
    expect(document.querySelector(".cam-subs-row")).toBeNull();
    expect(document.querySelector(`[data-acc-id="${credit.id}"]`)).not.toBeNull();
    document.querySelector(".cc-modal-close").click();
    expect(await p).toBeNull();
  });

  it("leaves API credit out when the chat cannot run on it", async () => {
    const p = openChangeAccountForChat({ currentId: personal.id, subsCount: 2, apiCreditAllowed: false });
    await flush();
    expect(document.querySelector(`[data-acc-id="${credit.id}"]`)).toBeNull();
    document.querySelector(".cc-modal-close").click();
    await p;
  });
});

describe("planAccountMove", () => {
  const main = inst("main", personal.id);
  const sessions = [
    main,
    inst("sub-a", personal.id, { subchat_of: "main" }),
    inst("sub-b", work.id, { subchat_of: "main" }),
    inst("sub-done", personal.id, { subchat_of: "main", subchat_finished: true }),
    inst("sub-ended", personal.id, { subchat_of: "main", ended_at: "2026-11-13T00:00:00Z" }),
    inst("other-sub", personal.id, { subchat_of: "other" }),
  ];

  it("moves every live or finished sub not already on the target, never an ended one", () => {
    expect(movableSubs("main", sessions).map((s) => s.session_id)).toEqual(["sub-a", "sub-b", "sub-done"]);
    expect(planAccountMove(main, sessions, work.id, true)).toEqual({ moveChat: true, subIds: ["sub-a", "sub-done"] });
  });

  it("moves only the chat with the switch off", () => {
    expect(planAccountMove(main, sessions, work.id, false)).toEqual({ moveChat: true, subIds: [] });
  });

  it("moves only the subs when the chat already runs on the target", () => {
    expect(planAccountMove(main, sessions, personal.id, true)).toEqual({ moveChat: false, subIds: ["sub-b"] });
  });
});

describe("moveChatToAccount with subs", () => {
  it("moves the chat, then each sub, and names the subs in the toast", async () => {
    const follow = vi.fn().mockResolvedValue(undefined);
    await moveChatToAccount("main", work.id, "work", follow, { moveChat: true, subIds: ["sub-a", "sub-b"] });
    expect(moveSessionToAccount.mock.calls).toEqual([["main", work.id], ["sub-a", work.id], ["sub-b", work.id]]);
    expect(showToast).toHaveBeenCalledWith("Now on Work, with 2 subchats.");
    expect(follow).toHaveBeenCalledWith("main");
  });

  it("keeps moving the other subs when one fails, and says so", async () => {
    moveSessionToAccount.mockImplementation(async (id) => {
      if (id === "sub-a") throw new Error("refused");
      return id;
    });
    await moveChatToAccount("main", work.id, "work", vi.fn().mockResolvedValue(undefined), { moveChat: true, subIds: ["sub-a", "sub-b"] });
    expect(moveSessionToAccount).toHaveBeenCalledWith("sub-b", work.id);
    expect(showToast).toHaveBeenCalledWith("Now on Work, with 1 subchat. 1 subchat failed to move.");
  });

  it("says 0 moved plainly when every sub fails", async () => {
    moveSessionToAccount.mockImplementation(async (id) => {
      if (id !== "main") throw new Error("refused");
      return id;
    });
    await moveChatToAccount("main", work.id, "work", vi.fn().mockResolvedValue(undefined), { moveChat: true, subIds: ["sub-a", "sub-b"] });
    expect(showToast).toHaveBeenCalledWith("Now on Work. 2 subchats failed to move.");
  });

  it("shows the daemon's API-credit refusal instead of a bare failure", async () => {
    const refusal = "A chat using subchats, and each of its subs, cannot run on an API-credit account, since every sub would spend its credit. Pick a subscription account.";
    moveSessionToAccount.mockRejectedValue(refusal);
    await moveChatToAccount("main", credit.id, "API credit", vi.fn());
    expect(showToast).toHaveBeenCalledWith(refusal);
  });

  it("skips the chat's own call when only the subs move", async () => {
    await moveChatToAccount("main", work.id, "work", vi.fn().mockResolvedValue(undefined), { moveChat: false, subIds: ["sub-a"] });
    expect(moveSessionToAccount.mock.calls).toEqual([["sub-a", work.id]]);
  });

  it("moves just the chat by default, as the draft pane calls it", async () => {
    await moveChatToAccount("main", work.id, "work", vi.fn().mockResolvedValue(undefined));
    expect(moveSessionToAccount.mock.calls).toEqual([["main", work.id]]);
    expect(showToast).toHaveBeenCalledWith("Now on Work.");
  });
});
