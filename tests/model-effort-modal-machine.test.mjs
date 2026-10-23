// @vitest-environment jsdom
//
// A chat aimed at a paired machine (the new-chat picker's machine chip) picks
// its account from THAT machine's registry: ids and project folders are per
// machine, so the local caches (this machine's accounts and binding) must not
// be read, the pick is sent as `accountId`, and it is saved on the host as the
// project's binding. Real model-effort-data, account-field and probe run here;
// only the transport, the slider/character panes and the local caches are stubs.

import { describe, it, expect, vi, afterEach } from "vitest";

const remote = { value: false };
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => remote.value }));

const mocks = vi.hoisted(() => ({
  listMachineAccounts: vi.fn(),
  listMachines: vi.fn(),
  setMachineProjectAccount: vi.fn(),
  ensureProject: vi.fn(),
  updateProject: vi.fn(),
  probeModelsAvailability: vi.fn(),
  projectsListData: vi.fn(),
  accountsListData: vi.fn(),
  projectAccountData: vi.fn(),
}));
vi.mock("../src/shared/api.ts", () => ({
  api: {
    listMachineAccounts: (...a) => mocks.listMachineAccounts(...a),
    listMachines: (...a) => mocks.listMachines(...a),
    setMachineProjectAccount: (...a) => mocks.setMachineProjectAccount(...a),
    ensureProject: (...a) => mocks.ensureProject(...a),
    updateProject: (...a) => mocks.updateProject(...a),
    probeModelsAvailability: (...a) => mocks.probeModelsAvailability(...a),
  },
}));

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn() }));
vi.mock("../src/shared/settings-update.ts", () => ({ updateSettings: vi.fn().mockResolvedValue(undefined) }));

// This machine's own default account differs from every id below on purpose:
// if the modal read local data, the preselect would not match the peer's.
vi.mock("../src/views/sessions/new-session-cache.ts", () => ({
  settingsData: () => ({ cached: { default_account_id: "local-default" }, ready: Promise.resolve({}) }),
  projectsListData: (...a) => mocks.projectsListData(...a),
  accountsListData: (...a) => mocks.accountsListData(...a),
  projectAccountData: (...a) => mocks.projectAccountData(...a),
  resolveCached: async (read, fallback) => (read.cached !== undefined ? read.cached : read.ready.catch(() => fallback)),
}));

vi.mock("../src/views/sessions/character-pane.ts", () => ({
  cancelCharacterPaneSound: () => {},
  createCharacterPane: () => ({ render: () => {}, loadPool: () => {}, currentCharacterId: () => null }),
}));
vi.mock("../src/views/sessions/slider-controller.ts", () => ({
  createSliderController: () => ({
    html: () => "",
    captureFlipState: () => new Map(),
    playFlip: () => {},
    positionAll: () => {},
    wire: () => {},
  }),
}));

const { openModelEffortModal } = await import("../src/views/sessions/model-effort-modal.ts");

const WIN_PATH = "C:/Users/joe/winproj";
const winAccount = (id, label) => ({
  id, label, colour: "#112233", icon: "briefcase", email: `${id}@win.test`, subscription_tier: "max",
});
const WORK = winAccount("win-work", "Win Work");
const PERSONAL = winAccount("win-personal", "Win Personal");

function peerList(over = {}) {
  return { accounts: [WORK, PERSONAL], default_account_id: null, project_account_id: null, ...over };
}

function overlay() {
  return document.querySelector("#modal-host .model-effort-modal-card");
}

function chipLabels() {
  return [...overlay().querySelectorAll(".me-acc-edit .account-chip")].map((c) => c.textContent.trim());
}

async function openForPeer() {
  const pending = openModelEffortModal(WIN_PATH, "winproj", "mach-win");
  await vi.waitFor(() => expect(overlay()).not.toBeNull());
  return pending;
}

function pressEscape() {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
}

afterEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.listMachines.mockResolvedValue({ self: null, peers: [{ machine_id: "mach-win", label: "Windows PC" }] });
  mocks.setMachineProjectAccount.mockResolvedValue({ ok: true });
  remote.value = false;
});

describe("openModelEffortModal for a paired machine", () => {
  it("lists the peer's accounts, preselects its project binding and sends it as accountId", async () => {
    mocks.listMachines.mockResolvedValue({ self: null, peers: [{ machine_id: "mach-win", label: "Windows PC" }] });
    mocks.setMachineProjectAccount.mockResolvedValue({ ok: true });
    mocks.listMachineAccounts.mockResolvedValue(peerList({ default_account_id: "win-work", project_account_id: "win-personal" }));

    const pending = openForPeer();
    await vi.waitFor(() => expect(overlay()?.querySelector(".me-acc-edit")).toBeTruthy());

    expect(mocks.listMachineAccounts).toHaveBeenCalledWith("mach-win", WIN_PATH);
    expect(chipLabels()).toEqual(["Win Work", "Win Personal"]);
    // A peer's chips carry the email so look-alike labels can be told apart.
    expect(overlay().querySelector('[data-acc-id="win-work"]').getAttribute("title")).toBe("win-work@win.test");
    expect(overlay().querySelector('[data-acc-id="win-personal"]').classList.contains("sel")).toBe(true);

    overlay().querySelector(".me-confirm").click();
    const result = await pending;

    expect(result.accountId).toBe("win-personal");
    // Local data is never read for a peer, and this machine's availability
    // probe (local credentials, local ids) never runs against its account ids.
    expect(mocks.projectsListData).not.toHaveBeenCalled();
    expect(mocks.accountsListData).not.toHaveBeenCalled();
    expect(mocks.projectAccountData).not.toHaveBeenCalled();
    expect(mocks.probeModelsAvailability).not.toHaveBeenCalled();
    // The binding it started from is already saved there: no write.
    expect(mocks.setMachineProjectAccount).not.toHaveBeenCalled();
    expect(mocks.ensureProject).not.toHaveBeenCalled();
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it("falls back to the peer's default when the project has no binding", async () => {
    mocks.listMachineAccounts.mockResolvedValue(peerList({ default_account_id: "win-work" }));

    const pending = openForPeer();
    await vi.waitFor(() => expect(overlay()?.querySelector(".me-confirm")).toBeTruthy());
    expect(overlay().querySelector('[data-acc-id="win-work"]').classList.contains("sel")).toBe(true);
    expect(overlay().querySelector(".me-confirm").disabled).toBe(false);
    overlay().querySelector(".me-confirm").click();

    expect((await pending).accountId).toBe("win-work");
  });

  it("keeps Start disabled until a pick when the peer's accounts are ambiguous, then saves the pick on the peer", async () => {
    mocks.listMachineAccounts.mockResolvedValue(peerList());

    const pending = openForPeer();
    await vi.waitFor(() => expect(overlay()?.querySelector(".me-confirm")).toBeTruthy());
    expect(overlay().querySelector(".me-confirm").disabled).toBe(true);

    overlay().querySelector('[data-acc-id="win-work"]').click();
    expect(overlay().querySelector(".me-confirm").disabled).toBe(false);
    overlay().querySelector(".me-confirm").click();
    const result = await pending;

    expect(result.accountId).toBe("win-work");
    expect(mocks.setMachineProjectAccount).toHaveBeenCalledWith("mach-win", WIN_PATH, "win-work");
    expect(mocks.ensureProject).not.toHaveBeenCalled();
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it("saves the pick on the peer from the phone too, since the write lands on the host", async () => {
    remote.value = true;
    mocks.listMachineAccounts.mockResolvedValue(peerList({ project_account_id: "win-work" }));

    const pending = openForPeer();
    await vi.waitFor(() => expect(overlay()?.querySelector(".me-confirm")).toBeTruthy());
    overlay().querySelector('[data-acc-id="win-personal"]').click();
    overlay().querySelector(".me-confirm").click();
    await pending;

    expect(mocks.setMachineProjectAccount).toHaveBeenCalledWith("mach-win", WIN_PATH, "win-personal");
  });

  it("a refused binding write never blocks the start", async () => {
    mocks.listMachineAccounts.mockResolvedValue(peerList());
    mocks.setMachineProjectAccount.mockRejectedValue(new Error("this machine can view chats here but only drive the ones it started"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const pending = openForPeer();
    await vi.waitFor(() => expect(overlay()?.querySelector(".me-confirm")).toBeTruthy());
    overlay().querySelector('[data-acc-id="win-work"]').click();
    overlay().querySelector(".me-confirm").click();

    expect((await pending).accountId).toBe("win-work");
    err.mockRestore();
  });

  it("an unreachable peer says so and keeps Start disabled instead of starting on a default", async () => {
    mocks.listMachineAccounts.mockRejectedValue(new Error("Windows PC is offline"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const pending = openForPeer();
    await vi.waitFor(() => expect(overlay()?.querySelector(".me-acc-empty")).toBeTruthy());

    expect(overlay().querySelector(".me-acc-empty").textContent).toContain("Couldn't load Windows PC's accounts");
    expect(overlay().querySelector(".me-acc-empty").textContent).toContain("Windows PC is offline");
    expect(overlay().querySelector(".me-confirm").disabled).toBe(true);
    expect(overlay().querySelector(".me-acc-add-link")).toBeNull();

    pressEscape();
    expect(await pending).toBeNull();
    err.mockRestore();
  });

  it("a peer with no accounts names it and offers no local Settings link", async () => {
    mocks.listMachineAccounts.mockResolvedValue(peerList({ accounts: [] }));

    const pending = openForPeer();
    await vi.waitFor(() => expect(overlay()?.querySelector(".me-acc-empty")).toBeTruthy());

    expect(overlay().querySelector(".me-acc-empty").textContent).toContain("Windows PC has no Claude accounts yet");
    expect(overlay().querySelector(".me-acc-add-link")).toBeNull();
    expect(overlay().querySelector(".me-confirm").disabled).toBe(true);

    pressEscape();
    await pending;
  });
});
