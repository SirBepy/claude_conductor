// @vitest-environment jsdom
//
// A chat hosted on a paired machine (the Mac app showing a PC chat) has its
// cwd on the host's disk and its account id from the host's account list.
// The todos chip must read the host's backlog (by session id, forwarded by
// the daemon) and the account chip must resolve the id against the host's
// accounts - reading this machine's disk and cache left both chips hidden.

import { describe, it, expect, vi, beforeEach } from "vitest";

const calls = [];
const ipcMock = { impl: async () => null };
// Only the phone draws the todos chip (the desktop split's Backlog tab replaced it).
const env = { remote: true };
vi.mock("../src/shared/transport.ts", async (orig) => ({ ...(await orig()), isRemote: () => env.remote }));
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn((cmd, args) => { calls.push([cmd, args]); return ipcMock.impl(cmd, args); }),
}));

const { SessionStatusbar } = await import("../src/views/sessions/session-statusbar.ts");
const { setCachedAccounts } = await import("../src/shared/accounts-cache.ts");

const PC_CWD = "C:\\Users\\tecno\\Desktop\\Projects\\app";
const hostAccounts = [
  { id: "pc-personal", label: "personal", colour: "#9d7dfc", icon: "user", email: "", subscription_tier: "max" },
  { id: "pc-work", label: "work", colour: "#f5a623", icon: "briefcase", email: "", subscription_tier: "max" },
];

function mount(rows, opts = {}) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const sb = new SessionStatusbar(el, null, rows, { cwd: PC_CWD, sessionId: "sess-pc", hideZero: true, ...opts });
  return { el, sb };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  env.remote = true;
  calls.length = 0;
  document.body.innerHTML = "";
  // This machine (the Mac) has one account, none of the host's ids.
  setCachedAccounts([{ id: "mac-only", label: "mac", colour: "#000", icon: "user" }]);
  ipcMock.impl = async (cmd) => {
    if (cmd === "list_ai_todos") return [{ name: "01-a.md", path: `${PC_CWD}\\.claude\\todos\\01-a.md` }, { name: "02-b.md", path: "x" }];
    if (cmd === "list_machine_accounts") return { accounts: hostAccounts, default_account_id: null, project_account_id: null };
    return null;
  };
});

describe("statusbar chips for a chat mirrored from a paired machine", () => {
  it("reads the todos list on the host by session id", async () => {
    const { el } = mount([["ai_todos"]], { mirrored: true, machineId: "pc" });
    await flush();
    const todoCall = calls.find(([c]) => c === "list_ai_todos");
    expect(todoCall[1]).toEqual({ cwd: PC_CWD, sessionId: "sess-pc" });
    expect(el.querySelector(".sb-ai-todos")?.textContent).toContain("2");
  });

  it("draws no todos chip and reads no list on the desktop, where the Backlog tab replaced it", async () => {
    env.remote = false;
    const { el } = mount([["ai_todos"]]);
    await flush();
    expect(calls.find(([c]) => c === "list_ai_todos")).toBeUndefined();
    expect(el.querySelector(".sb-ai-todos")).toBeNull();
  });

  it("keeps a local chat's todos read to cwd alone", async () => {
    mount([["ai_todos"]]);
    await flush();
    expect(calls.find(([c]) => c === "list_ai_todos")[1]).toEqual({ cwd: PC_CWD });
  });

  it("names the host's account, forced into the row by the host's account count", async () => {
    const { el } = mount([["git"]], { mirrored: true, machineId: "pc", accountId: "pc-work", onAccountClick: () => {} });
    await flush();
    expect(calls.find(([c]) => c === "list_machine_accounts")[1]).toEqual({ machineId: "pc", cwd: PC_CWD });
    const chip = el.querySelector(".sb-account");
    expect(chip?.textContent).toContain("Work");
    // No account move across machines, so the chip is a label, not a button.
    expect(chip?.classList.contains("sb-account-btn")).toBe(false);
  });

  it("shows no account chip while the host's list is unreachable", async () => {
    ipcMock.impl = async (cmd) => {
      if (cmd === "list_machine_accounts") throw new Error("machine offline");
      return null;
    };
    setCachedAccounts([
      { id: "pc-work", label: "local work", colour: "#000", icon: "user" },
      { id: "other", label: "other", colour: "#000", icon: "user" },
    ]);
    const { el } = mount([["account"]], { mirrored: true, machineId: "pc", accountId: "pc-work" });
    await flush();
    expect(el.querySelector(".sb-account")).toBeNull();
  });
});
