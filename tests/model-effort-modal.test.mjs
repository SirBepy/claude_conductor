// @vitest-environment jsdom
//
// Todo 1066: starting a new chat from the phone must never call
// ensure_project/update_project - the phone (HTTP) transport refuses both, so
// the old unconditional persistAccountBinding() logged a RemoteUnavailableError
// on every phone "Start session". Pins the isRemote() guard added to
// model-effort-modal.ts's persistAccountBinding(): the desktop path still
// registers+binds the project to the picked account, the phone path skips
// both calls outright.
//
// Every other collaborator (character pane, slider, account field, model
// probe, the four new-session-cache reads) is mocked to a no-op stub: this
// test only pins the account-binding call, not their own rendering, which is
// covered elsewhere (new-chat-accounts.view.spec.ts etc). shared/modal.ts is
// left real (same pattern as tests/api-key-modal.test.mjs) since it is generic
// host plumbing, not part of what's under test.

import { describe, it, expect, vi, afterEach } from "vitest";

const remote = { value: false };
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => remote.value }));

const { ensureProject, updateProject } = vi.hoisted(() => ({
  ensureProject: vi.fn(),
  updateProject: vi.fn(),
}));
vi.mock("../src/shared/api.ts", () => ({
  api: {
    ensureProject: (...a) => ensureProject(...a),
    updateProject: (...a) => updateProject(...a),
  },
}));

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn() }));
vi.mock("../src/shared/settings-update.ts", () => ({ updateSettings: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/shared/account-chip.ts", () => ({ attachChipKeyboardActivation: () => {} }));

vi.mock("../src/views/sessions/new-session-cache.ts", () => ({
  settingsData: () => ({ cached: {}, ready: Promise.resolve({}) }),
  projectsListData: () => ({ cached: [], ready: Promise.resolve([]) }),
  accountsListData: () => ({ cached: [], ready: Promise.resolve([]) }),
  projectAccountData: () => ({ cached: null, ready: Promise.resolve(null) }),
}));

// ACCOUNT_ID differs from PREFERRED_ACCOUNT_ID so persistAccountBinding's own
// early return ("nothing picked, or it's already the preferred one") doesn't
// mask the isRemote() guard this test is pinning. projectId: null forces the
// ensureProject branch too, so a regression that guards only updateProject
// still fails this test.
const ACCOUNT_ID = "acc2";
const PREFERRED_ACCOUNT_ID = "acc1";
vi.mock("../src/views/sessions/model-effort-data.ts", () => ({
  resolveModelEffortData: async () => ({
    models: ["opus"],
    model: "opus",
    effort: "high",
    autoAccept: true,
    projectId: null,
    preferredAccountId: PREFERRED_ACCOUNT_ID,
    accounts: [{ id: "acc1", label: "A" }, { id: "acc2", label: "B" }],
    accountId: ACCOUNT_ID,
    idByFamily: new Map(),
  }),
}));

vi.mock("../src/views/sessions/account-field.ts", () => ({
  accountPickIncomplete: () => false,
  renderAccountFieldHtml: () => "",
  attachAccountFieldHandlers: () => {},
}));

vi.mock("../src/views/sessions/character-pane.ts", () => ({
  cancelCharacterPaneSound: () => {},
  createCharacterPane: () => ({
    render: () => {},
    loadPool: () => {},
    currentCharacterId: () => null,
  }),
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

vi.mock("../src/views/sessions/model-effort-probe.ts", () => ({
  createModelProbeController: () => ({
    state: { availability: {}, authExpired: false, modelProbeLoading: false },
    seedIdByFamily: () => {},
    primeLoadingFlag: () => {},
    runProbe: () => {},
    onAccountPicked: () => {},
    cycleAccount: () => {},
  }),
}));

const { openModelEffortModal } = await import("../src/views/sessions/model-effort-modal.ts");

function overlay() {
  return document.querySelector("#modal-host .model-effort-modal-card");
}

afterEach(() => {
  ensureProject.mockReset();
  updateProject.mockReset();
  // Each test drives a real Start-session click through to close(), which
  // hands the shared #modal-host's teardown back to closeHostCard() - same
  // singleton the app reuses across repeat opens, nothing to tear down here.
});

describe("openModelEffortModal - persistAccountBinding's isRemote guard (todo 1066)", () => {
  it("desktop: registers the project and binds the picked account", async () => {
    remote.value = false;
    ensureProject.mockResolvedValue({ id: "proj1" });
    updateProject.mockResolvedValue(undefined);

    const pending = openModelEffortModal("C:/Projects/alpha", "alpha");
    await vi.waitFor(() => expect(overlay()).not.toBeNull());
    overlay().querySelector(".me-confirm").click();
    await pending;

    expect(ensureProject).toHaveBeenCalledWith("C:/Projects/alpha");
    expect(updateProject).toHaveBeenCalledWith("proj1", { preferred_account_id: ACCOUNT_ID });
  });

  it("phone: starts the chat without calling ensureProject or updateProject", async () => {
    remote.value = true;

    const pending = openModelEffortModal("C:/Projects/alpha", "alpha");
    await vi.waitFor(() => expect(overlay()).not.toBeNull());
    overlay().querySelector(".me-confirm").click();
    const result = await pending;

    expect(ensureProject).not.toHaveBeenCalled();
    expect(updateProject).not.toHaveBeenCalled();
    // The guard only skips the persist - the session itself still starts.
    expect(result).not.toBeNull();
  });
});
