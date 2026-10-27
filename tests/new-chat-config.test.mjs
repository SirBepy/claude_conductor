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
}));
const cached = (v) => ({ cached: v, ready: Promise.resolve(v) });

vi.mock("../src/views/sessions/new-session-cache.ts", () => ({
  settingsData: () => cached(reads.settings),
  projectsListData: () => cached(reads.projects),
  accountsListData: () => cached(reads.accounts),
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

const { resolveNewChatConfig, accountPickNeeded, persistNewChatChoice, pickRandomCharacter } =
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
    expect(await accountPickNeeded(config)).toBe(true);
  });

  it("opens on the project's last model/effort, Opus/high the first time", async () => {
    expect(await resolveNewChatConfig(PATH)).toMatchObject({ model: "opus", effort: "high" });
    reads.settings = { projectLastChoice: { [PATH]: { model: "sonnet", effort: "low" } } };
    expect(await resolveNewChatConfig(PATH)).toMatchObject({ model: "sonnet", effort: "low" });
  });

  it("rolls a character from the project's pool", async () => {
    reads.chars = [{ id: "gazlowe", label: "Gazlowe" }];
    expect((await resolveNewChatConfig(PATH)).characterId).toBe("gazlowe");
  });
});

describe("accountPickNeeded", () => {
  it("never blocks a chat that has an account", async () => {
    expect(await accountPickNeeded({ model: "opus", effort: "high", accountId: "work" })).toBe(false);
  });

  it("lets the daemon pick when no accounts are registered at all", async () => {
    reads.accounts = [];
    expect(await accountPickNeeded({ model: "opus", effort: "high", accountId: null })).toBe(false);
  });

  it("always blocks a paired machine's chat with no account", async () => {
    reads.accounts = [];
    expect(await accountPickNeeded({ model: "opus", effort: "high", accountId: null, machineId: "m1" })).toBe(true);
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
