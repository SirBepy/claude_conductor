// @vitest-environment jsdom
//
// A new chat opens straight into the draft (no dialog): what it starts with,
// when its first send has to wait for an account, and what it remembers once
// sent.

import { describe, it, expect, vi, beforeEach } from "vitest";

const reads = vi.hoisted(() => ({
  settings: {},
  projects: [],
  accounts: [],
  projectAccount: null,
  chars: [],
  failAccounts: null,
}));
const cached = (v) => ({ cached: v, ready: Promise.resolve(v) });

vi.mock("../src/views/sessions/new-session-cache.ts", () => ({
  settingsData: () => cached(reads.settings),
  projectsListData: () => cached(reads.projects),
  accountsListData: () => reads.failAccounts ?? cached(reads.accounts),
  projectAccountData: () => cached(reads.projectAccount),
  whitelistCharsData: () => cached(reads.chars),
  resolveCached: async (read, fallback) => read.cached ?? (await read.ready.catch(() => fallback)),
}));
const apiMock = vi.hoisted(() => ({
  ensureProject: vi.fn(async () => ({ id: "new-proj" })),
  updateProject: vi.fn(async () => {}),
  setMachineProjectAccount: vi.fn(async () => {}),
  listMachineAccounts: vi.fn(),
  listMachines: vi.fn(async () => ({ peers: [] })),
}));
vi.mock("../src/shared/api.ts", () => ({ api: apiMock }));
const settingsWrites = vi.hoisted(() => []);
vi.mock("../src/shared/settings-update.ts", () => ({
  updateSettings: vi.fn(async (fn) => { settingsWrites.push(fn({})); }),
}));
const remote = vi.hoisted(() => ({ on: false }));
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => remote.on }));
vi.mock("../src/shared/character-select-sound.ts", () => ({ playCharacterSelectSound: vi.fn() }));

const { resolveNewChatConfig, accountPickNeeded, noAccountsRegistered, persistNewChatChoice, pickRandomCharacter } =
  await import("../src/views/sessions/new-chat-config.ts");

const personal = { id: "personal", label: "personal", kind: "subscription" };
const work = { id: "work", label: "work", kind: "subscription" };
const credit = { id: "credit", label: "API credit", kind: "api_credit" };
const PATH = "C:/Projects/conductor";

beforeEach(() => {
  reads.settings = {};
  reads.projects = [{ id: "p1", path: PATH }];
  reads.accounts = [personal, work];
  reads.projectAccount = null;
  reads.chars = [];
  reads.failAccounts = null;
  settingsWrites.length = 0;
  remote.on = false;
  vi.clearAllMocks();
});

describe("resolveNewChatConfig", () => {
  it("uses the project's bound account over the default", async () => {
    reads.projectAccount = "work";
    reads.settings = { default_account_id: "personal" };
    expect((await resolveNewChatConfig(PATH)).accountId).toBe("work");
  });

  it("falls back to the default account when the project has no binding", async () => {
    reads.settings = { default_account_id: "personal" };
    expect((await resolveNewChatConfig(PATH)).accountId).toBe("personal");
  });

  it("leaves the account unset with several accounts and no default", async () => {
    const config = await resolveNewChatConfig(PATH);
    expect(config.accountId).toBeNull();
    expect(await accountPickNeeded(config, PATH)).toBe(true);
  });

  it("opens on Sonnet/high when neither the project nor the settings pick a default", async () => {
    expect(await resolveNewChatConfig(PATH)).toMatchObject({ model: "sonnet", effort: "high" });
  });

  it("opens on the global default model/effort", async () => {
    reads.settings = { defaultModel: "opus", defaultEffort: "max" };
    expect(await resolveNewChatConfig(PATH)).toMatchObject({ model: "opus", effort: "max" });
  });

  it("the project's default beats both the global default and the last chat's choice", async () => {
    reads.settings = {
      defaultModel: "opus", defaultEffort: "max",
      projectLastChoice: { [PATH]: { model: "haiku", effort: "low" } },
    };
    reads.projects = [{ id: "p1", path: PATH, default_model: "sonnet", default_effort: "medium" }];
    expect(await resolveNewChatConfig(PATH)).toMatchObject({ model: "sonnet", effort: "medium" });
  });

  it("a project that pins only the model takes the effort from the global default", async () => {
    reads.settings = { defaultEffort: "low" };
    reads.projects = [{ id: "p1", path: PATH, default_model: "haiku", default_effort: null }];
    expect(await resolveNewChatConfig(PATH)).toMatchObject({ model: "haiku", effort: "low" });
  });

  it("rolls a character from the project's pool", async () => {
    reads.chars = [{ id: "gazlowe", label: "Gazlowe" }];
    expect((await resolveNewChatConfig(PATH)).characterId).toBe("gazlowe");
  });
});

describe("accountPickNeeded", () => {
  it("never blocks a chat that has an account", async () => {
    expect(await accountPickNeeded({ model: "opus", effort: "high", accountId: "work" }, PATH)).toBe(false);
  });

  it("asks for no pick when no accounts are registered at all (that is a different guidance)", async () => {
    reads.accounts = [];
    expect(await accountPickNeeded({ model: "opus", effort: "high", accountId: null }, PATH)).toBe(false);
  });

  const peerDraft = { model: "opus", effort: "high", accountId: null, machineId: "m1" };
  const peerList = (accounts, def = null) => ({ accounts, default_account_id: def, project_account_id: null });

  it("blocks a paired machine's chat when the peer has accounts and no default", async () => {
    apiMock.listMachineAccounts.mockResolvedValue(peerList([personal, work]));
    expect(await accountPickNeeded(peerDraft, PATH)).toBe(true);
    expect(apiMock.listMachineAccounts).toHaveBeenCalledWith("m1", PATH);
  });

  it("lets a paired machine with no accounts send, whatever this machine has", async () => {
    reads.accounts = [personal, work];
    apiMock.listMachineAccounts.mockResolvedValue(peerList([]));
    expect(await accountPickNeeded(peerDraft, PATH)).toBe(false);
  });

  it("leaves a peer that has its own default to resolve it host-side", async () => {
    apiMock.listMachineAccounts.mockResolvedValue(peerList([personal, work], "work"));
    expect(await accountPickNeeded(peerDraft, PATH)).toBe(false);
  });

  it("does not strand a draft whose peer cannot be reached", async () => {
    apiMock.listMachineAccounts.mockRejectedValue(new Error("offline"));
    expect(await accountPickNeeded(peerDraft, PATH)).toBe(false);
  });
});

describe("noAccountsRegistered", () => {
  const bare = { model: "opus", effort: "high", accountId: null };

  it("is true when the registry is empty and the chat has no account", async () => {
    reads.accounts = [];
    expect(await noAccountsRegistered(bare)).toBe(true);
  });

  it("is false once any account exists", async () => {
    expect(await noAccountsRegistered(bare)).toBe(false);
  });

  it("is false for a chat that carries an account", async () => {
    reads.accounts = [];
    expect(await noAccountsRegistered({ ...bare, accountId: "work" })).toBe(false);
  });

  it("is false for a paired machine's chat, whose accounts live on the peer", async () => {
    reads.accounts = [];
    expect(await noAccountsRegistered({ ...bare, machineId: "m1" })).toBe(false);
  });

  it("is false when the account list fails to load", async () => {
    reads.accounts = undefined;
    const failed = { cached: undefined, ready: Promise.reject(new Error("offline")) };
    failed.ready.catch(() => {});
    reads.failAccounts = failed;
    expect(await noAccountsRegistered(bare)).toBe(false);
  });
});

describe("persistNewChatChoice", () => {
  it("remembers model/effort and binds a newly picked account to the project", async () => {
    await persistNewChatChoice(PATH, { model: "sonnet", effort: "max", accountId: "work" });
    expect(settingsWrites[0].projectLastChoice[PATH]).toEqual({ model: "sonnet", effort: "max" });
    expect(apiMock.updateProject).toHaveBeenCalledWith("p1", { preferred_account_id: "work" });
  });

  it("leaves an unchanged binding alone", async () => {
    reads.projectAccount = "work";
    await persistNewChatChoice(PATH, { model: "opus", effort: "high", accountId: "work" });
    expect(apiMock.updateProject).not.toHaveBeenCalled();
  });

  it("never binds an API-credit account to the project", async () => {
    reads.accounts = [personal, credit];
    await persistNewChatChoice(PATH, { model: "opus", effort: "high", accountId: "credit" });
    expect(apiMock.updateProject).not.toHaveBeenCalled();
  });

  it("writes nothing local from the phone", async () => {
    remote.on = true;
    await persistNewChatChoice(PATH, { model: "opus", effort: "high", accountId: "work" });
    expect(settingsWrites).toHaveLength(0);
    expect(apiMock.updateProject).not.toHaveBeenCalled();
  });
});

describe("pickRandomCharacter", () => {
  it("prefers a character no live chat holds, else any", () => {
    const pool = [{ id: "a" }, { id: "b" }];
    expect(pickRandomCharacter(pool, new Set(["a"])).id).toBe("b");
    expect(["a", "b"]).toContain(pickRandomCharacter(pool, new Set(["a", "b"])).id);
    expect(pickRandomCharacter([], new Set())).toBeNull();
  });
});
